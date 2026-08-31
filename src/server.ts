// avcs-server — the avcs protocol, multi-repo, self-hostable.
//
// A CLEAN-ROOM implementation: written from the protocol spec (avcs docs/26) and the
// published `@izagood/avcs` library only. The conformance suite is the definition of done —
// a level is "supported" here exactly when `npm run conformance` in the avcs repo passes it
// against this server.
//
// Serves every conformance level — core, sync, governance, queue — one plane per section
// below. The judgement plane (finalize / integrate) is delegated to the library's `Repo`:
// the queue verdict must be a pure function of objects + Protection (docs/26 §6-2), and a
// second implementation of that function is exactly how two servers drift apart.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "@izagood/avcs/store";
import { HUB_PROTOCOL_VERSION, Repo } from "@izagood/avcs";

/**
 * One path segment of an org or repo name. The prefix routes straight to a directory under
 * the data root, so this regex is the traversal boundary — `..`, separators, empty and
 * dot-leading segments must never reach `join`.
 */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TRAVERSAL_SAFE = (s: string): boolean => SEGMENT.test(s) && s !== "." && s !== ".." && !s.includes("/");

/** An oid as the protocol shapes it: `<type>_<hex>`. Also filename-safe by construction. */
const OID = /^[a-z_]+_[0-9a-f]+$/;

const MAX_BODY = 8 * 1024 * 1024;
const MAX_BATCH_OBJECTS = 4096;
const MAX_FETCH_OIDS = 4096;
// The server bounds its OWN /objects/fetch response and says `truncated` — a client cannot
// make it materialize an unbounded payload by asking for everything at once (docs/26 §4-6).
const MAX_FETCH_BYTES = 4 * 1024 * 1024;

/** What a parked /events waiter (and every /sync-shaped answer) is answered with. Refs ride
 *  every response because a finalize can move `head:<view>` without appending an object
 *  (docs/26 §6-3) — without them a waiter would never see the head advance. */
interface EventsSnapshot { cursor: number; oids: string[]; refs: Record<string, string> }

async function eventsSnapshot(store: ObjectStore, since: number): Promise<EventsSnapshot> {
  const all = await store.readObjLog();
  const oids = since > 0 && since <= all.length ? all.slice(since) : all;
  return { cursor: all.length, oids, refs: Object.fromEntries(await store.listRefs()) };
}

/** Parked /events long-polls for ONE repo, answered on the next mutation or their timeout.
 *  Bounded: past `maxWaiters` a new poll gets 503 immediately — parked sockets are the one
 *  thing a long-poll endpoint can exhaust. */
class EventsHub {
  #waiters = new Set<{ res: ServerResponse; since: number; timer: NodeJS.Timeout }>();
  readonly #store: ObjectStore;
  readonly #maxWaiters: number;
  constructor(store: ObjectStore, maxWaiters = 256) {
    this.#store = store;
    this.#maxWaiters = maxWaiters;
  }

  park(res: ServerResponse, since: number, timeoutMs: number): void {
    if (this.#waiters.size >= this.#maxWaiters) {
      sendJson(res, 503, { error: "too many parked /events waiters" });
      return;
    }
    const waiter = { res, since, timer: setTimeout(() => this.#answer(waiter), timeoutMs) };
    this.#waiters.add(waiter);
    res.on("close", () => { clearTimeout(waiter.timer); this.#waiters.delete(waiter); });
  }

  /** Called after every successful mutation (object put, finalize, integrate). Waiters are
   *  answered with a fresh snapshot even when no oid was appended — a ref-only mutation is
   *  exactly the case the refs-in-every-response design exists for. */
  wake(): void {
    for (const w of [...this.#waiters]) this.#answer(w);
  }

  #answer(w: { res: ServerResponse; since: number; timer: NodeJS.Timeout }): void {
    if (!this.#waiters.delete(w)) return;
    clearTimeout(w.timer);
    eventsSnapshot(this.#store, w.since)
      .then((snap) => sendJson(w.res, 200, snap))
      .catch((e) => sendJson(w.res, 500, { error: String((e as Error).message) }));
  }

  close(): void {
    for (const w of [...this.#waiters]) this.#answer(w);
  }
}

export interface AvcsServerOpts {
  /** Directory holding one object store per `<org>/<repo>`. Created on demand. */
  dataDir: string;
  port?: number;
  host?: string;
}

export interface AvcsServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startAvcsServer(opts: AvcsServerOpts): Promise<AvcsServerHandle> {
  await mkdir(opts.dataDir, { recursive: true });

  // One context per repo, created lazily. The store itself is the library's — content
  // addressing, the interop-safe gate and group-committed durability all ride along, which
  // is the point of building on the published package instead of re-deriving any of it.
  // The judgement plane opens the same directory as a `Repo` per request, exactly like the
  // reference — the cross-process finalize lock, not a long-lived handle, is the serializer.
  interface RepoCtx { dir: string; store: ObjectStore; events: EventsHub }
  const repos = new Map<string, RepoCtx>();
  const ctxFor = async (org: string, repo: string): Promise<RepoCtx> => {
    const key = `${org}/${repo}`;
    let c = repos.get(key);
    if (!c) {
      const dir = join(opts.dataDir, org, repo);
      await mkdir(dir, { recursive: true });
      const store = new ObjectStore(dir);
      await store.init();
      c = { dir, store, events: new EventsHub(store) };
      repos.set(key, c);
    }
    return c;
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      // A handler that throws is a server bug, not a protocol answer — say so as 500 and
      // keep serving. Nothing in the protocol maps to this.
      sendJson(res, 500, { error: String((e as Error).message) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    // Bare operability, outside any repo prefix.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Everything else lives under /<org>/<repo>/… — the server picks the prefix shape
    // (docs/26 §1) and this one routes it to a per-repo store directory.
    if (parts.length < 3) {
      sendJson(res, 404, { error: "not found — protocol paths live under /<org>/<repo>/…" });
      return;
    }
    const [org, repo, ...rest] = parts as [string, string, ...string[]];
    if (!TRAVERSAL_SAFE(org) || !TRAVERSAL_SAFE(repo)) {
      sendJson(res, 400, { error: "org and repo must be single path segments" });
      return;
    }
    const path = "/" + rest.join("/");
    const ctx = await ctxFor(org, repo);
    const store = ctx.store;

    // ── capability advertisement (docs/26 §3) ─────────────────────────────────────────
    // Advertise exactly what is served. A flag for a route this server does not have would
    // turn the client's working fallback into a hard failure.
    if (req.method === "GET" && path === "/version") {
      sendJson(res, 200, {
        name: "avcs-server",
        protocol: HUB_PROTOCOL_VERSION,
        gated: false,
        auth: "none",
        integrate: true,
        events: true,
        batch: true,
        batchMaxBytes: MAX_BODY,
      });
      return;
    }

    // ── the three CORE endpoints (docs/26 §0) ─────────────────────────────────────────
    if (req.method === "GET" && path === "/have") {
      // Names only, never bodies — the spec's own reference had to learn this the hard way.
      sendJson(res, 200, await store.listOids());
      return;
    }

    if (req.method === "GET" && rest[0] === "objects" && rest.length === 2) {
      const oid = decodeURIComponent(rest[1]!);
      if (!OID.test(oid)) {
        sendJson(res, 404, { error: "not found" }); // an unshaped oid can never exist here
        return;
      }
      if (!(await store.has(oid))) {
        // 404 is a normal answer (§4-3): the client treats it as a raced eviction and skips.
        sendJson(res, 404, { error: "not found" });
        return;
      }
      sendJson(res, 200, await store.get(oid));
      return;
    }

    if (req.method === "POST" && path === "/objects") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (e) {
        sendJson(res, 413, { error: String((e as Error).message) });
        return;
      }
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (typeof obj !== "object" || obj === null || typeof (obj as { type?: unknown }).type !== "string") {
        sendJson(res, 400, { error: "object must have a string `type`" });
        return;
      }
      // §6-2: integration objects are authored by an integration queue. This server does not
      // run one, so accepting a pushed Integration would let anyone forge queue history at
      // its content address — refused even though the queue itself is not served yet.
      if ((obj as { type: string }).type === "integration") {
        sendJson(res, 403, { error: "integration objects are authored by the integration queue; they cannot be pushed" });
        return;
      }
      // §8: the claimed oid is ignored — store.put recomputes the content address, so a
      // forged object lands at its own oid and cannot displace anything. The library's
      // interop-safe gate (docs/24) also runs inside put; its refusal is a caller error.
      let oid: string;
      try {
        oid = await store.put(obj as never);
      } catch (e) {
        sendJson(res, 400, { error: String((e as Error).message) });
        return;
      }
      ctx.events.wake(); // a new object (or an idempotent re-put) is what waiters wait for
      sendJson(res, 200, { oid });
      return;
    }

    // ── sync plane (docs/26 §4-2, §4-5, §4-6) ─────────────────────────────────────────
    if (req.method === "GET" && path === "/sync") {
      const sinceRaw = Number(url.searchParams.get("since") ?? "0");
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      // The cursor is the objlog index. Correctness never depends on it: 0 or out-of-range
      // degrades to the full set — a wrong cursor costs transfer, never convergence.
      const snap = await eventsSnapshot(store, since);
      sendJson(res, 200, { oids: snap.oids, cursor: snap.cursor });
      return;
    }

    if (req.method === "POST" && path === "/objects/fetch") {
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { sendJson(res, e instanceof SyntaxError ? 400 : 413, { error: String((e as Error).message) }); return; }
      const asked = (body as { oids?: unknown } | null)?.oids;
      if (!Array.isArray(asked)) { sendJson(res, 400, { error: "fetch requires { oids: [...] }" }); return; }
      if (asked.length > MAX_FETCH_OIDS) { sendJson(res, 413, { error: `fetch exceeds ${MAX_FETCH_OIDS} oids` }); return; }
      const objects: unknown[] = [];
      let bytes = 0;
      let truncated = false;
      for (const oid of asked) {
        if (typeof oid !== "string" || !OID.test(oid)) continue; // an unshaped oid can never exist
        if (!(await store.has(oid))) continue;                   // absence is a raced eviction, not an error
        const obj = await store.get(oid);
        bytes += JSON.stringify(obj).length;
        // Always take at least one past the limit rather than stopping before it — a response
        // that carries nothing reads as "no progress" and makes the client give up (§4-6).
        objects.push(obj);
        if (bytes >= MAX_FETCH_BYTES) { truncated = true; break; }
      }
      sendJson(res, 200, { objects, truncated });
      return;
    }

    if (req.method === "POST" && path === "/objects/batch") {
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { sendJson(res, e instanceof SyntaxError ? 400 : 413, { error: String((e as Error).message) }); return; }
      const objects = (body as { objects?: unknown } | null)?.objects;
      if (!Array.isArray(objects)) { sendJson(res, 400, { error: "batch requires { objects: [...] }" }); return; }
      if (objects.length > MAX_BATCH_OBJECTS) { sendJson(res, 413, { error: `batch exceeds ${MAX_BATCH_OBJECTS} objects` }); return; }
      // Per-object verdicts are the load-bearing part (§4-5): one refusal never fails the
      // request, because the client's push ledger is built from exactly what was accepted.
      // Validation stays per object and IN ORDER; storage is group-committed via putMany,
      // falling back to one-by-one when a chunk is refused (the interop gate) so the rest
      // of the batch still lands.
      const results: ({ oid: string | null; status: "stored" } | { oid: string | null; status: "rejected"; reason: string })[] = new Array(objects.length);
      const accepted: { at: number; obj: object }[] = [];
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        if (typeof o !== "object" || o === null || typeof (o as { type?: unknown }).type !== "string") {
          results[i] = { oid: null, status: "rejected", reason: "object must have a string `type`" };
          continue;
        }
        if ((o as { type: string }).type === "integration") {
          results[i] = { oid: null, status: "rejected", reason: "integration objects are authored by the integration queue; they cannot be pushed" };
          continue;
        }
        accepted.push({ at: i, obj: o });
      }
      if (accepted.length > 0) {
        let put: { oid: string }[];
        try {
          put = await store.putMany(accepted.map((a) => a.obj) as never);
        } catch {
          put = [];
          for (const a of accepted) {
            try { put.push({ oid: await store.put(a.obj as never) }); }
            catch (inner) {
              results[a.at] = { oid: null, status: "rejected", reason: String((inner as Error).message) };
              put.push({ oid: "" });
            }
          }
        }
        for (let j = 0; j < accepted.length; j++) {
          const oid = put[j]?.oid;
          if (oid) results[accepted[j]!.at] = { oid, status: "stored" };
        }
        ctx.events.wake(); // once per batch — waiters re-snapshot regardless of count
      }
      sendJson(res, 200, { results });
      return;
    }

    // ── governance plane (docs/26 §5, §6-1) ───────────────────────────────────────────
    if (req.method === "GET" && path === "/refs") {
      sendJson(res, 200, { refs: Object.fromEntries(await store.listRefs()) });
      return;
    }

    if (req.method === "POST" && path === "/finalize") {
      let body: { view?: unknown; newCheckpoint?: unknown; parentHead?: unknown; by?: unknown };
      try { body = JSON.parse(await readBody(req)) as typeof body; }
      catch (e) { sendJson(res, e instanceof SyntaxError ? 400 : 413, { error: String((e as Error).message) }); return; }
      const { view, newCheckpoint, by } = body;
      if (typeof view !== "string" || typeof newCheckpoint !== "string" || typeof by !== "string") {
        sendJson(res, 400, { error: "finalize requires string { view, newCheckpoint, by }" });
        return;
      }
      const parentHead = typeof body.parentHead === "string" ? body.parentHead : null;
      const repoApi = await Repo.open(ctx.dir);
      const result = await repoApi.finalize({ view, newCheckpoint, parentHead, by });
      if (result.finalized) {
        ctx.events.wake(); // head moved WITHOUT appending an object — the ref-only mutation
        sendJson(res, 200, result);
        return;
      }
      // A lost CAS race is a 409 conflict; everything else (role, checks, approvals,
      // incomplete history) is a 422 — the submission itself is unprocessable.
      sendJson(res, /head moved/.test(result.reason) ? 409 : 422, result);
      return;
    }

    // ── judgement plane (docs/26 §6-2, §6-3) ──────────────────────────────────────────
    if (req.method === "POST" && path === "/integrate") {
      let body: { view?: unknown; checkpoint?: unknown; by?: unknown; ticketId?: unknown };
      try { body = JSON.parse(await readBody(req)) as typeof body; }
      catch (e) { sendJson(res, e instanceof SyntaxError ? 400 : 413, { error: String((e as Error).message) }); return; }
      const { view, checkpoint, by } = body;
      if (typeof view !== "string" || typeof checkpoint !== "string" || typeof by !== "string") {
        sendJson(res, 400, { error: "integrate requires string { view, checkpoint, by }" });
        return;
      }
      if (!(await store.has(checkpoint))) {
        sendJson(res, 422, { verdict: "rejected", reason: `checkpoint ${checkpoint} not on the server — push it first` });
        return;
      }
      const ticketId = typeof body.ticketId === "string" ? body.ticketId : undefined;
      // The verdict is the library's, not this server's: docs/26 §6-2 requires every queue
      // decision to be a pure function of objects + Protection, and `Repo.submitIntegration`
      // is that function. This server only maps verdicts to status codes.
      const repoApi = await Repo.open(ctx.dir);
      const result = await repoApi.submitIntegration({ view, checkpoint, by, ticketId });
      const status = result.verdict === "advanced" ? 200
        : result.verdict === "queued" ? 202
        : result.verdict === "conflict" ? 409
        : result.verdict === "needs_evidence" ? 428
        : 422;
      ctx.events.wake(); // every judged verdict appends an Integration object; advanced also moves the head
      sendJson(res, status, result);
      return;
    }

    if (req.method === "GET" && rest[0] === "integrations" && rest.length === 2) {
      // Idempotent verdict lookup: the ticket ref points at the recorded Integration object.
      const ticketId = decodeURIComponent(rest[1]!);
      const view = url.searchParams.get("view") ?? "main";
      const ref = await store.getRef(`integration:${view}:${ticketId}`);
      if (!ref || !(await store.has(ref))) {
        sendJson(res, 404, { error: "no such integration ticket", view, ticketId });
        return;
      }
      sendJson(res, 200, await store.get(ref));
      return;
    }

    if (req.method === "GET" && path === "/events") {
      const sinceRaw = Number(url.searchParams.get("since") ?? "0");
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      const toRaw = Number(url.searchParams.get("timeoutMs") ?? "30000");
      const timeoutMs = Math.min(Math.max(Number.isFinite(toRaw) ? Math.floor(toRaw) : 30_000, 10), 120_000);
      // `since` is the SAME cursor /sync uses — one cursor meaning (§6-3). Behind ⇒ answer
      // now; caught up ⇒ park until a mutation wakes us or the timeout heartbeats.
      const snap = await eventsSnapshot(store, since);
      if (snap.oids.length > 0) {
        sendJson(res, 200, snap);
        return;
      }
      ctx.events.park(res, since, timeoutMs);
      return;
    }

    // Optional endpoints this version does not serve. 404 is the protocol's word for
    // "fall back" (§0) — never a 5xx, which the client would read as a broken server.
    sendJson(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    close: () => {
      for (const c of repos.values()) c.events.close(); // answer parked waiters, then stop
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
