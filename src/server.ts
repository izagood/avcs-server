// avcs-server — the avcs protocol, multi-repo, self-hostable.
//
// A CLEAN-ROOM implementation: written from the protocol spec (avcs docs/26) and the
// published `@izagood/avcs` library only. The conformance suite is the definition of done —
// a level is "supported" here exactly when `npm run conformance` in the avcs repo passes it
// against this server.
//
// v0 serves the CORE level: the three endpoints a conforming server cannot be without
// (docs/26 §0). Everything else is optional by protocol design — the client reads capability
// flags from GET /version and falls back on its own — so this server is honest about what it
// does not serve yet: `batch`, `integrate` and `events` advertise false, and the routes
// answer 404, which the spec defines as "fall back", not "error".
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "@izagood/avcs/store";
import { HUB_PROTOCOL_VERSION } from "@izagood/avcs";

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

  // One store handle per repo, created lazily. The store itself is the library's — content
  // addressing, the interop-safe gate and group-committed durability all ride along, which
  // is the point of building on the published package instead of re-deriving any of it.
  const stores = new Map<string, ObjectStore>();
  const storeFor = async (org: string, repo: string): Promise<ObjectStore> => {
    const key = `${org}/${repo}`;
    let s = stores.get(key);
    if (!s) {
      const dir = join(opts.dataDir, org, repo);
      await mkdir(dir, { recursive: true });
      s = new ObjectStore(dir);
      await s.init();
      stores.set(key, s);
    }
    return s;
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
    const store = await storeFor(org, repo);

    // ── capability advertisement (docs/26 §3) ─────────────────────────────────────────
    // Advertise exactly what is served. A flag for a route this server does not have would
    // turn the client's working fallback into a hard failure.
    if (req.method === "GET" && path === "/version") {
      sendJson(res, 200, {
        name: "avcs-server",
        protocol: HUB_PROTOCOL_VERSION,
        gated: false,
        auth: "none",
        integrate: false,
        events: false,
        batch: false,
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
      sendJson(res, 200, { oid });
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
