// The protocol engine — every docs/26 endpoint as a transport-agnostic function:
// (raw request parts) → { status, body }. No node:http, no framework. A binding (this
// package's stdlib one, or a consumer's Fastify/Express adapter) only parses the URL,
// collects the body, calls one method, and writes the answer.
//
// This split is the package's reason to exist as a *library*: the protocol implementation
// stays in one public place, and a hosted product imports it and injects its concerns
// through the SPI instead of maintaining a parallel server that drifts.
import { HUB_PROTOCOL_VERSION, MATERIALIZER_VERSION, canonicalize, sha256hex, verifyAuth, NonceCache } from "@izagood/avcs";
import type {
  Answer,
  Hooks,
  IdentityProvider,
  JudgementBackend,
  ReductionBackend,
  RepoRef,
  StorageBackend,
  StoredObject,
  WriteEvent,
} from "./spi.ts";

export const MAX_BODY = 8 * 1024 * 1024;
export const MAX_BATCH_OBJECTS = 4096;
export const MAX_FETCH_OIDS = 4096;
// The engine bounds its OWN /objects/fetch response and says `truncated` — a client cannot
// make it materialize an unbounded payload by asking for everything at once (docs/26 §4-6).
export const MAX_FETCH_BYTES = 4 * 1024 * 1024;
/** Cap on `tree` entries a /reduced answer carries (avcs docs/27 §4.1). Above it the tree is
 *  OMITTED — never truncated; a truncated tree reads as deletions. Advertised as
 *  `reducedTreeMaxEntries` so a client learns it up front instead of through a surprise. */
export const REDUCED_TREE_MAX_ENTRIES = 50_000;

/** Refs that never feed a reduction and grow without bound — one per integration ticket, one
 *  per bridged git sha. Everything else stays in the ETag, conservatively (docs/27 §3.4). */
const ETAG_EXCLUDED_REF = /^(integration:|git:)/;

/** The wire shape of GET /reduced (docs/26 §6-4). */
interface ReducedBody {
  view: string;
  cursor: number;
  materializer: string;
  treeHash: string;
  statuses: Record<string, string>;
  headOps: string[];
  conflicts: unknown[];
  fileConflicts: unknown[];
  blockedReasons: Record<string, string>;
  untrustedEvidence: number;
  tree?: Record<string, string>;
  synth?: string[];
  treeOmitted: boolean;
}
interface ReducedEntry { etag: string; body: ReducedBody; synth: Record<string, Uint8Array> }

/** An oid as the protocol shapes it: `<type>_<hex>`. Also filename-safe by construction. */
export const OID = /^[a-z_]+_[0-9a-f]+$/;

export interface EngineOpts {
  repo: RepoRef;
  store: StorageBackend;
  /** Absent ⇒ the judgement plane is not served: /finalize and /integrate answer 404 and
   *  `integrate` advertises false. A partial server is a first-class one (docs/26 §0). */
  judge?: JudgementBackend;
  /** Absent ⇒ the derived-state plane is not served: /reduced answers 404 and `reduced`
   *  advertises false. Independent of `judge` — a mirror may serve one without the other. */
  reducer?: ReductionBackend;
  /** `tree` entries above which /reduced omits the tree (default 50 000). */
  reducedTreeMaxEntries?: number;
  /** Writes must carry a valid AVCS-Sig by a resolvable member (docs/26 §7). */
  gated?: boolean;
  /** "public" (default): reads are open. "token": a read must carry a bearer token the
   *  identity provider accepts, or a valid member signature. */
  readAccess?: "public" | "token";
  identity?: IdentityProvider;
  hooks?: Hooks;
  /** AVCS-Sig freshness window override (test hook). */
  authWindowMs?: number;
  maxEventsWaiters?: number;
}

/** What /sync, /events and a parked waiter are answered with. Refs ride every /events
 *  response because a finalize can move `head:<view>` without appending an object
 *  (docs/26 §6-3) — without them a waiter would never see the head advance. */
interface Snapshot {
  cursor: number;
  oids: string[];
  refs: Record<string, string>;
}

/** The identity the default (core-native) provider implements: `member:<keyId>` refs
 *  pointing at Membership objects already in the store — the same shape /refs distributes. */
export function coreNativeIdentity(store: StorageBackend): IdentityProvider {
  return {
    async resolvePublicKey(_repo: RepoRef, keyId: string): Promise<string | null> {
      const ref = await store.getRef(`member:${keyId}`);
      if (!ref || !(await store.has(ref))) return null;
      const m = (await store.get(ref)) as { publicKey?: unknown; status?: unknown };
      if (typeof m.publicKey !== "string") return null;
      if (typeof m.status === "string" && m.status !== "active") return null;
      return m.publicKey;
    },
  };
}

export class RepoEngine {
  readonly #repo: RepoRef;
  readonly #store: StorageBackend;
  readonly #judge: JudgementBackend | null;
  readonly #reducer: ReductionBackend | null;
  readonly #treeMax: number;
  #reducedCache = new Map<string, ReducedEntry>();
  readonly #gated: boolean;
  readonly #readAccess: "public" | "token";
  readonly #identity: IdentityProvider;
  readonly #hooks: Hooks;
  readonly #nonces = new NonceCache();
  readonly #authWindowMs: number | undefined;
  readonly #maxWaiters: number;
  #waiters = new Set<{ since: number; timer: NodeJS.Timeout; resolve: (a: Answer) => void }>();

  constructor(opts: EngineOpts) {
    this.#repo = opts.repo;
    this.#store = opts.store;
    this.#judge = opts.judge ?? null;
    this.#reducer = opts.reducer ?? null;
    this.#treeMax = opts.reducedTreeMaxEntries ?? REDUCED_TREE_MAX_ENTRIES;
    this.#gated = opts.gated ?? false;
    this.#readAccess = opts.readAccess ?? "public";
    this.#identity = opts.identity ?? coreNativeIdentity(opts.store);
    this.#hooks = opts.hooks ?? {};
    this.#authWindowMs = opts.authWindowMs;
    this.#maxWaiters = opts.maxEventsWaiters ?? 256;
  }

  // ── capability advertisement (docs/26 §3) ───────────────────────────────────────────
  // Advertise exactly what is composed in: a flag for a plane this instance does not have
  // would turn the client's working fallback into a hard failure.
  version(): Answer {
    return {
      status: 200,
      body: {
        name: "avcs-server",
        protocol: HUB_PROTOCOL_VERSION,
        // docs/26 §3: the reducer version is the ground for "same op set ⇒ same tree". It was
        // missing here until docs/27 needed it on the /reduced answer as well.
        materializer: MATERIALIZER_VERSION,
        gated: this.#gated,
        auth: this.#gated ? "required" : "none",
        integrate: this.#judge !== null,
        events: true,
        batch: true,
        batchMaxBytes: MAX_BODY,
        reduced: this.#reducer !== null,
        // Only when advertised — a cap for a plane this instance does not have is noise.
        ...(this.#reducer !== null ? { reducedTreeMaxEntries: this.#treeMax } : {}),
      },
    };
  }

  // ── transport auth (docs/26 §7) ─────────────────────────────────────────────────────
  // Verification is the library's `verifyAuth` — the canonical implementation; the engine
  // only wires the directory (identity SPI) and the scope (this repo's URL prefix, so a
  // credential captured for another tenant is refused even when everything else checks out).
  async #verifyWrite(method: string, path: string, body: string, header: string | undefined):
    Promise<{ ok: true; keyId?: string } | Answer> {
    if (!this.#gated) return { ok: true };
    const result = await verifyAuth({
      header,
      method,
      path,
      body,
      resolvePublicKey: (keyId) => this.#identity.resolvePublicKey(this.#repo, keyId),
      now: Date.now(),
      nonceCache: this.#nonces,
      ...(this.#authWindowMs !== undefined ? { windowMs: this.#authWindowMs } : {}),
      expectedScope: `/${this.#repo.org}/${this.#repo.repo}`,
    });
    if (!result.ok) {
      // 401 = the signature is missing or does not verify (an unknown key cannot verify).
      return { status: 401, body: { error: result.reason } };
    }
    return { ok: true, keyId: result.keyId };
  }

  /** Read gate: open by default; in token mode a bearer the identity provider accepts, or a
   *  valid member signature (readAuthHeaders sends one when the client holds a key). */
  async verifyRead(method: string, path: string, body: string, authorization: string | undefined): Promise<Answer | null> {
    if (this.#readAccess === "public") return null;
    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length).trim();
      if (this.#identity.verifyReadToken && (await this.#identity.verifyReadToken(this.#repo, token))) return null;
      return { status: 401, body: { error: "read token not accepted" } };
    }
    const result = await verifyAuth({
      header: authorization,
      method,
      path,
      body,
      resolvePublicKey: (keyId) => this.#identity.resolvePublicKey(this.#repo, keyId),
      now: Date.now(),
      nonceCache: this.#nonces,
      ...(this.#authWindowMs !== undefined ? { windowMs: this.#authWindowMs } : {}),
      expectedScope: `/${this.#repo.org}/${this.#repo.repo}`,
    });
    return result.ok ? null : { status: 401, body: { error: "reads require a bearer token or a member signature" } };
  }

  async #vetoed(ev: WriteEvent): Promise<Answer | null> {
    if (!this.#hooks.beforeWrite) return null;
    const v = await this.#hooks.beforeWrite(ev);
    if (v.ok) return null;
    return {
      status: v.status,
      body: { error: v.error, ...(v.details ?? {}) },
      ...(v.retryAfterSeconds !== undefined ? { retryAfterSeconds: v.retryAfterSeconds } : {}),
    };
  }

  #observed(ev: WriteEvent & { stored: StoredObject[]; verdict?: string }): void {
    // Best-effort by contract: the mutation is already durable; a product hook failure is
    // the product's problem, never the protocol answer's.
    try {
      void Promise.resolve(this.#hooks.afterWrite?.(ev)).catch(() => {});
    } catch {
      /* same contract for a synchronous throw */
    }
  }

  // ── object plane (docs/26 §4) ───────────────────────────────────────────────────────
  async have(): Promise<Answer> {
    return { status: 200, body: await this.#store.listOids() };
  }

  async sync(sinceRaw: string | null): Promise<Answer> {
    const snap = await this.#snapshot(parseSince(sinceRaw));
    return { status: 200, body: { oids: snap.oids, cursor: snap.cursor } };
  }

  async getObject(oid: string): Promise<Answer> {
    // 404 is a normal answer (§4-3): the client treats it as a raced eviction and skips.
    if (!OID.test(oid) || !(await this.#store.has(oid))) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: await this.#store.get(oid) };
  }

  async putObject(raw: string, authHeader: string | undefined, context?: unknown): Promise<Answer> {
    const auth = await this.#verifyWrite("POST", "/objects", raw, authHeader);
    if (!("ok" in auth)) return auth;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const shape = refuseShape(obj);
    if (shape) return { status: shape.status, body: { error: shape.error } };
    const bytes = Buffer.byteLength(raw);
    const ev: WriteEvent = { repo: this.#repo, kind: "objects", count: 1, bytes, ...(auth.keyId ? { actor: auth.keyId } : {}), ...(context !== undefined ? { context } : {}) };
    const veto = await this.#vetoed(ev);
    if (veto) return veto;
    let oid: string;
    try {
      // §8: the claimed oid is ignored — the backend recomputes the content address, so a
      // forged object lands at its own oid and cannot displace anything. The interop gate
      // (docs/24) also runs inside put; its refusal is a caller error.
      oid = await this.#store.put(obj as object);
    } catch (e) {
      return { status: 400, body: { error: String((e as Error).message) } };
    }
    this.wake(); // a new object (or an idempotent re-put) is what waiters wait for
    this.#observed({ ...ev, stored: [{ oid, type: (obj as { type: string }).type, bytes }] });
    return { status: 200, body: { oid } };
  }

  async batch(raw: string, authHeader: string | undefined, context?: unknown): Promise<Answer> {
    const auth = await this.#verifyWrite("POST", "/objects/batch", raw, authHeader);
    if (!("ok" in auth)) return auth;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const objects = (body as { objects?: unknown } | null)?.objects;
    if (!Array.isArray(objects)) return { status: 400, body: { error: "batch requires { objects: [...] }" } };
    if (objects.length > MAX_BATCH_OBJECTS) return { status: 413, body: { error: `batch exceeds ${MAX_BATCH_OBJECTS} objects` } };
    const sizes = objects.map((o) => Buffer.byteLength(JSON.stringify(o) ?? ""));
    const ev: WriteEvent = {
      repo: this.#repo, kind: "objects/batch", count: objects.length,
      bytes: sizes.reduce((a, b) => a + b, 0),
      ...(auth.keyId ? { actor: auth.keyId } : {}),
      ...(context !== undefined ? { context } : {}),
    };
    const veto = await this.#vetoed(ev);
    if (veto) return veto;
    // Per-object verdicts are the load-bearing part (§4-5): one refusal never fails the
    // request, because the client's push ledger is built from exactly what was accepted.
    // Validation stays per object and IN ORDER; storage is group-committed via putMany,
    // falling back to one-by-one when a chunk is refused (the interop gate) so the rest
    // of the batch still lands.
    const results: ({ oid: string | null; status: "stored" } | { oid: string | null; status: "rejected"; reason: string })[] =
      new Array(objects.length);
    const accepted: { at: number; obj: object }[] = [];
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      const shape = refuseShape(o);
      if (shape) {
        results[i] = { oid: null, status: "rejected", reason: shape.error };
        continue;
      }
      accepted.push({ at: i, obj: o as object });
    }
    const stored: StoredObject[] = [];
    if (accepted.length > 0) {
      let put: { oid: string }[];
      try {
        put = await this.#store.putMany(accepted.map((a) => a.obj));
      } catch {
        put = [];
        for (const a of accepted) {
          try {
            put.push({ oid: await this.#store.put(a.obj) });
          } catch (inner) {
            results[a.at] = { oid: null, status: "rejected", reason: String((inner as Error).message) };
            put.push({ oid: "" });
          }
        }
      }
      for (let j = 0; j < accepted.length; j++) {
        const oid = put[j]?.oid;
        if (oid) {
          const at = accepted[j]!.at;
          results[at] = { oid, status: "stored" };
          stored.push({ oid, type: (accepted[j]!.obj as { type: string }).type, bytes: sizes[at] ?? 0 });
        }
      }
      this.wake(); // once per batch — waiters re-snapshot regardless of count
    }
    this.#observed({ ...ev, stored });
    return { status: 200, body: { results } };
  }

  async fetchObjects(raw: string): Promise<Answer> {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const asked = (body as { oids?: unknown } | null)?.oids;
    if (!Array.isArray(asked)) return { status: 400, body: { error: "fetch requires { oids: [...] }" } };
    if (asked.length > MAX_FETCH_OIDS) return { status: 413, body: { error: `fetch exceeds ${MAX_FETCH_OIDS} oids` } };
    const objects: unknown[] = [];
    let bytes = 0;
    let truncated = false;
    for (const oid of asked) {
      if (typeof oid !== "string" || !OID.test(oid)) continue; // an unshaped oid can never exist
      if (!(await this.#store.has(oid))) continue; // absence is a raced eviction, not an error
      const obj = await this.#store.get(oid);
      bytes += JSON.stringify(obj).length;
      // Always take at least one past the limit rather than stopping before it — a response
      // that carries nothing reads as "no progress" and makes the client give up (§4-6).
      objects.push(obj);
      if (bytes >= MAX_FETCH_BYTES) {
        truncated = true;
        break;
      }
    }
    return { status: 200, body: { objects, truncated } };
  }

  // ── governance plane (docs/26 §5, §6-1) ─────────────────────────────────────────────
  async refs(): Promise<Answer> {
    return { status: 200, body: { refs: Object.fromEntries(await this.#store.listRefs()) } };
  }

  // ── derived-state plane (docs/26 §6-4, avcs docs/27) ────────────────────────────────
  /** GET /reduced?view= — the derived state a replica would compute. NOT an authority:
   *  every replica computes the same value from the same objects; this exists so a client
   *  that does not replicate (a web UI, a bot, another language) can read it at all.
   *  ETag = fingerprint of the reduction's inputs; If-None-Match ⇒ 304 without a reduce. */
  async reduced(viewRaw: string | null, ifNoneMatch: string | undefined): Promise<Answer> {
    if (!this.#reducer) return { status: 404, body: { error: "not found" } };
    const view = viewRaw ?? "main";
    const entry = await this.#reducedFor(view);
    if (!entry) return { status: 404, body: { error: `no such view: ${view}` } };
    if (ifNoneMatch === entry.etag) return { status: 304, body: null, etag: entry.etag };
    return { status: 200, body: entry.body, etag: entry.etag };
  }

  /** GET /reduced/blob/:oid?view= — bytes of a SYNTHETIC blob (docs/27 §3.2): a 3-way merge
   *  result exists in no store and must not be put in one (redaction would leave plaintext).
   *  Only this view's current synth oids answer 200; a stored blob is 404 here (the two routes
   *  never overlap); an If-Match that no longer holds is 412 — re-read /reduced. */
  async reducedBlob(oid: string, viewRaw: string | null, ifMatch: string | undefined): Promise<Answer> {
    if (!this.#reducer) return { status: 404, body: { error: "not found" } };
    const view = viewRaw ?? "main";
    const entry = await this.#reducedFor(view);
    if (!entry) return { status: 404, body: { error: `no such view: ${view}` } };
    if (typeof ifMatch === "string" && ifMatch !== entry.etag) {
      return { status: 412, body: { error: "reduction changed — re-read /reduced", etag: entry.etag }, etag: entry.etag };
    }
    const bytes = entry.synth[oid];
    if (!bytes) return { status: 404, body: { error: "not a synthetic blob of this view's current reduction", oid, view }, etag: entry.etag };
    return { status: 200, body: { oid, data: Buffer.from(bytes).toString("base64"), encoding: "base64" }, etag: entry.etag };
  }

  /** Same inputs ⇒ same body: a tag match is a safe 304 and a safe cache hit. The same
   *  algorithm as the reference implementation, so the two agree on a shared store. */
  async #reducedEtag(view: string): Promise<{ etag: string; cursor: number }> {
    const all = await this.#store.readObjLog();
    const refs: Record<string, string> = {};
    for (const [name, oid] of await this.#store.listRefs()) if (!ETAG_EXCLUDED_REF.test(name)) refs[name] = oid;
    const digest = sha256hex(canonicalize({ v: 1, view, cursor: all.length, materializer: MATERIALIZER_VERSION, treeMaxEntries: this.#treeMax, refs }));
    return { etag: `"${digest.slice(0, 32)}"`, cursor: all.length };
  }

  /** The cached reduction for `view`, recomputed only when its tag moved. The tag is read
   *  before AND after the backend call and cached only when both agree — the proof the body
   *  belongs to the tag. (The default backend's first materialize on a pushed-to store seeds
   *  `view:main`, which appends an object; the loop simply reduces once more.) If the store
   *  keeps moving, the fresh body is served uncached under the older tag, so the next request
   *  recomputes and a stale 304 can never be issued. */
  async #reducedFor(view: string): Promise<ReducedEntry | null> {
    let pre = await this.#reducedEtag(view);
    const hit = this.#reducedCache.get(view);
    if (hit && hit.etag === pre.etag) return hit;
    for (let attempt = 0; ; attempt++) {
      const r = await this.#reducer!.reduce({ view });
      if (!r) return null;
      const post = await this.#reducedEtag(view);
      const base = {
        view, cursor: pre.cursor, materializer: MATERIALIZER_VERSION, treeHash: r.treeHash,
        statuses: r.statuses, headOps: r.headOps, conflicts: r.conflicts, fileConflicts: r.fileConflicts,
        blockedReasons: r.blockedReasons, untrustedEvidence: r.untrustedEvidence,
      };
      const body: ReducedBody = Object.keys(r.tree).length > this.#treeMax
        ? { ...base, treeOmitted: true }
        : { ...base, tree: r.tree, synth: Object.keys(r.synth).sort(), treeOmitted: false };
      const entry: ReducedEntry = { etag: pre.etag, body, synth: r.synth };
      if (post.etag === pre.etag) { this.#reducedCache.set(view, entry); return entry; }
      if (attempt >= 2) return entry; // store still moving — serve fresh, uncached, under the older tag
      pre = post;
    }
  }

  /**
   * The landed-workspace set (docs/26 §5-2).
   *
   * `/refs` distributes what the hub is authoritative for, one way, and a client never
   * pushes a ref. That is right for governance — but landing is authored by whoever ran
   * `avcs land`, so it flows the other way and needs a route of its own.
   *
   * Without one the fact is stranded: the blob naming the landed workspaces pushes fine as
   * an ordinary object, only the ref pointing at it cannot travel. The receiving replica
   * then sees an empty set, reduces that workspace's ops back out of the base view, and
   * materializes the pre-land tree — while the push reported success. Nothing surfaces,
   * because there is no error to raise (avcs#173).
   */
  async landed(): Promise<Answer> {
    return { status: 200, body: { landed: await this.#readLanded() } };
  }

  /**
   * Merge a client's landed set into the hub's.
   *
   * UNION, never replace. `landWorkspace` is idempotent add-only and there is no unland
   * (avcs docs/16 §5), so the set only grows: merging two of them cannot lose a name and
   * does not depend on arrival order. That is what makes this safe without a CAS —
   * concurrent landers converge on the same set whatever sequence the requests arrive in.
   */
  async putLanded(raw: string, authHeader: string | undefined): Promise<Answer> {
    if (!this.#store.setRef) return { status: 404, body: { error: "not found" } };
    const auth = await this.#verifyWrite("POST", "/landed", raw, authHeader);
    if (!("ok" in auth)) return auth;
    let body: { workspaces?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const incoming = body.workspaces;
    if (!Array.isArray(incoming) || incoming.some((w) => typeof w !== "string")) {
      return { status: 400, body: { error: "landed requires { workspaces: string[] }" } };
    }
    const have = new Set(await this.#readLanded());
    const before = have.size;
    for (const name of incoming as string[]) have.add(name);
    const landed = [...have].sort();
    // Write only when the set actually grew — a re-push of an unchanged set is a no-op
    // rather than a new blob plus a ref rewrite on every sync.
    if (have.size !== before) {
      const json = JSON.stringify(landed);
      const oid = await this.#store.put({
        type: "blob",
        data: Buffer.from(json, "utf8").toString("base64"),
        encoding: "base64",
      });
      await this.#store.setRef("workspaces.landed", oid);
    }
    return { status: 200, body: { landed } };
  }

  /** The landed names this hub holds, or `[]` when the ref is absent or unreadable. */
  async #readLanded(): Promise<string[]> {
    const ref = await this.#store.getRef("workspaces.landed");
    if (!ref) return [];
    try {
      const blob = (await this.#store.get(ref)) as { data?: string } | null;
      if (!blob?.data) return [];
      const parsed = JSON.parse(Buffer.from(blob.data, "base64").toString("utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  }

  async finalize(raw: string, authHeader: string | undefined, context?: unknown): Promise<Answer> {
    if (!this.#judge) return { status: 404, body: { error: "not found" } };
    const auth = await this.#verifyWrite("POST", "/finalize", raw, authHeader);
    if (!("ok" in auth)) return auth;
    let body: { view?: unknown; newCheckpoint?: unknown; parentHead?: unknown; by?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const { view, newCheckpoint, by } = body;
    if (typeof view !== "string" || typeof newCheckpoint !== "string" || typeof by !== "string") {
      return { status: 400, body: { error: "finalize requires string { view, newCheckpoint, by }" } };
    }
    const ev: WriteEvent = { repo: this.#repo, kind: "finalize", count: 1, bytes: Buffer.byteLength(raw), ...(auth.keyId ? { actor: auth.keyId } : {}), ...(context !== undefined ? { context } : {}) };
    const veto = await this.#vetoed(ev);
    if (veto) return veto;
    const parentHead = typeof body.parentHead === "string" ? body.parentHead : null;
    const result = await this.#judge.finalize({ view, newCheckpoint, parentHead, by });
    if (result.finalized) {
      this.wake(); // head moved WITHOUT appending an object — the ref-only mutation
      this.#observed({ ...ev, stored: [], verdict: "finalized" });
      return { status: 200, body: result };
    }
    // A lost CAS race is a 409 conflict; everything else (role, checks, approvals,
    // incomplete history) is a 422 — the submission itself is unprocessable.
    this.#observed({ ...ev, stored: [], verdict: "refused" });
    return { status: /head moved/.test(result.reason) ? 409 : 422, body: result };
  }

  // ── judgement plane (docs/26 §6-2, §6-3) ────────────────────────────────────────────
  async integrate(raw: string, authHeader: string | undefined, context?: unknown): Promise<Answer> {
    if (!this.#judge) return { status: 404, body: { error: "not found" } };
    const auth = await this.#verifyWrite("POST", "/integrate", raw, authHeader);
    if (!("ok" in auth)) return auth;
    let body: { view?: unknown; checkpoint?: unknown; by?: unknown; ticketId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const { view, checkpoint, by } = body;
    if (typeof view !== "string" || typeof checkpoint !== "string" || typeof by !== "string") {
      return { status: 400, body: { error: "integrate requires string { view, checkpoint, by }" } };
    }
    if (!(await this.#store.has(checkpoint))) {
      return { status: 422, body: { verdict: "rejected", reason: `checkpoint ${checkpoint} not on the server — push it first` } };
    }
    const ev: WriteEvent = { repo: this.#repo, kind: "integrate", count: 1, bytes: Buffer.byteLength(raw), ...(auth.keyId ? { actor: auth.keyId } : {}), ...(context !== undefined ? { context } : {}) };
    const veto = await this.#vetoed(ev);
    if (veto) return veto;
    const ticketId = typeof body.ticketId === "string" ? body.ticketId : undefined;
    // The verdict is the judge's (by default the library's `Repo.submitIntegration`) — a queue
    // decision must be a pure function of objects + Protection (§6-2), and a second
    // implementation of that function is exactly how two servers drift apart. The engine
    // only maps verdicts to status codes.
    const result = await this.#judge.submitIntegration({ view, checkpoint, by, ...(ticketId ? { ticketId } : {}) });
    const status =
      result.verdict === "advanced" ? 200
      : result.verdict === "queued" ? 202
      : result.verdict === "conflict" ? 409
      : result.verdict === "needs_evidence" ? 428
      : 422;
    this.wake(); // every judged verdict appends an Integration object; advanced also moves the head
    this.#observed({ ...ev, stored: [], verdict: String(result.verdict) });
    return { status, body: result };
  }

  async integrationLookup(ticketId: string, view: string): Promise<Answer> {
    // Idempotent verdict lookup: the ticket ref points at the recorded Integration object.
    const ref = await this.#store.getRef(`integration:${view}:${ticketId}`);
    if (!ref || !(await this.#store.has(ref))) {
      return { status: 404, body: { error: "no such integration ticket", view, ticketId } };
    }
    return { status: 200, body: await this.#store.get(ref) };
  }

  // ── live convergence (docs/26 §6-3) ─────────────────────────────────────────────────
  /** Resolves with the answer — immediately when the caller is behind, on the next mutation
   *  when caught up, or with a heartbeat at the timeout. Transport-agnostic: a binding just
   *  awaits and writes. */
  async events(sinceRaw: string | null, timeoutRaw: string | null, opts?: { signal?: AbortSignal }): Promise<Answer> {
    const since = parseSince(sinceRaw);
    const toNum = Number(timeoutRaw ?? "30000");
    const timeoutMs = Math.min(Math.max(Number.isFinite(toNum) ? Math.floor(toNum) : 30_000, 10), 120_000);
    const snap = await this.#snapshot(since);
    if (snap.oids.length > 0) return { status: 200, body: snap };
    if (this.#waiters.size >= this.#maxWaiters) {
      // Parked sockets are the one thing a long-poll endpoint can exhaust — refuse loudly.
      return { status: 503, body: { error: "too many parked /events waiters" } };
    }
    return new Promise<Answer>((resolve) => {
      const waiter = { since, resolve, timer: setTimeout(() => this.#answer(waiter), timeoutMs) };
      this.#waiters.add(waiter);
      // A poller that disconnected must free its slot NOW, not at the timeout — parked
      // slots are capacity (503 past the cap), so a leaver holding one starves live
      // pollers. The binding passes the request's abort signal; the promise still
      // resolves (with a final snapshot) so no caller is left hanging.
      opts?.signal?.addEventListener("abort", () => this.#answer(waiter), { once: true });
    });
  }

  /** Answer every parked waiter with a fresh snapshot. Called after each mutation; also the
   *  ref-only ones — that is exactly the case refs-in-every-response exists for. */
  wake(): void {
    for (const w of [...this.#waiters]) this.#answer(w);
  }

  /** Flush parked waiters (server shutdown). */
  close(): void {
    this.wake();
  }

  #answer(w: { since: number; timer: NodeJS.Timeout; resolve: (a: Answer) => void }): void {
    if (!this.#waiters.delete(w)) return;
    clearTimeout(w.timer);
    this.#snapshot(w.since)
      .then((snap) => w.resolve({ status: 200, body: snap }))
      .catch((e) => w.resolve({ status: 500, body: { error: String((e as Error).message) } }));
  }

  async #snapshot(since: number): Promise<Snapshot> {
    // The cursor is the objlog index — ONE meaning shared by /sync and /events (§6-3).
    // Correctness never depends on it: 0 or out-of-range degrades to the full set.
    const all = await this.#store.readObjLog();
    const oids = since > 0 && since <= all.length ? all.slice(since) : all;
    return { cursor: all.length, oids, refs: Object.fromEntries(await this.#store.listRefs()) };
  }
}

function parseSince(raw: string | null): number {
  const n = Number(raw ?? "0");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Object-shape refusals shared by /objects and /objects/batch. */
function refuseShape(o: unknown): { status: 400 | 403; error: string } | null {
  if (typeof o !== "object" || o === null || typeof (o as { type?: unknown }).type !== "string") {
    return { status: 400, error: "object must have a string `type`" };
  }
  const type = (o as { type: string }).type;
  if (type === "integration") {
    // §6-2: authored by the integration queue. A server accepting a pushed one would let
    // anyone forge queue history at its content address.
    return { status: 403, error: "integration objects are authored by the integration queue; they cannot be pushed" };
  }
  if (type === "redaction") {
    // Storing a redaction without APPLYING it (evicting the blob bytes) would let the client
    // believe an eviction propagated when it did not — worse than refusing. Propagation is
    // roadmap; until then this server does not take redactions.
    return { status: 403, error: "redaction propagation is not served yet" };
  }
  return null;
}
