// The stdlib http binding — and the reference for writing your own. Everything protocol
// lives in the engine (`./engine`, transport-agnostic); this file only parses the URL,
// collects the body, picks the engine method, and writes the answer. A consumer embedding
// the engine in another framework (Fastify, Express, …) reimplements THIS file, ~100 lines,
// and none of the protocol.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "@izagood/avcs/store";
import { Repo } from "@izagood/avcs";
import { RepoEngine, MAX_BODY } from "./engine.ts";
import type { Answer, Hooks, IdentityProvider, JudgementBackend, RepoRef, StorageBackend } from "./spi.ts";

export type { Answer, Hooks, IdentityProvider, JudgementBackend, RepoRef, StorageBackend, StoredObject, WriteEvent, WriteVeto } from "./spi.ts";
export { RepoEngine, coreNativeIdentity } from "./engine.ts";

/**
 * One path segment of an org or repo name. The prefix routes straight to a directory under
 * the data root, so this regex is the traversal boundary — `..`, separators, empty and
 * dot-leading segments must never reach `join`.
 */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TRAVERSAL_SAFE = (s: string): boolean => SEGMENT.test(s) && s !== "." && s !== ".." && !s.includes("/");

export interface AvcsServerOpts {
  /** Directory holding one object store per `<org>/<repo>`. Created on demand. */
  dataDir: string;
  port?: number;
  host?: string;
  /** Writes must carry a valid AVCS-Sig by a resolvable member (docs/26 §7). */
  gated?: boolean;
  /** "public" (default) or "token" — see EngineOpts. */
  readAccess?: "public" | "token";
  /** Membership/key/token directory. Default: core-native (`member:<keyId>` refs). */
  identity?: IdentityProvider;
  /** Product lifecycle around writes (quota veto, metering, webhooks, audit). */
  hooks?: Hooks;
  /** Storage per repo. Default: the library's ObjectStore on `<dataDir>/<org>/<repo>`. */
  storageFor?: (repo: RepoRef, dir: string) => Promise<StorageBackend>;
  /** Judgement per repo. Default: the library's `Repo` on the same directory. Return null
   *  to not serve the judgement plane (e.g. on a storage backend with no filesystem). */
  judgeFor?: (repo: RepoRef, dir: string) => Promise<JudgementBackend | null>;
  /** AVCS-Sig freshness window override (test hook). */
  authWindowMs?: number;
}

export interface AvcsServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startAvcsServer(opts: AvcsServerOpts): Promise<AvcsServerHandle> {
  await mkdir(opts.dataDir, { recursive: true });

  // One engine per repo, created lazily. The default backends are the library's — content
  // addressing, the interop-safe gate and group-committed durability all ride along, which
  // is the point of building on the published package instead of re-deriving any of it.
  // The default judge opens the same directory as a `Repo` per call, exactly like the
  // reference — the cross-process finalize lock, not a long-lived handle, is the serializer.
  const engines = new Map<string, Promise<RepoEngine>>();
  const engineFor = (repo: RepoRef): Promise<RepoEngine> => {
    const key = `${repo.org}/${repo.repo}`;
    let e = engines.get(key);
    if (!e) {
      e = (async () => {
        const dir = join(opts.dataDir, repo.org, repo.repo);
        await mkdir(dir, { recursive: true });
        let store: StorageBackend;
        if (opts.storageFor) {
          store = await opts.storageFor(repo, dir);
        } else {
          const s = new ObjectStore(dir);
          await s.init();
          store = s;
        }
        const judge = opts.judgeFor
          ? await opts.judgeFor(repo, dir)
          : {
              finalize: async (args: Parameters<JudgementBackend["finalize"]>[0]) =>
                (await Repo.open(dir)).finalize(args),
              submitIntegration: async (args: Parameters<JudgementBackend["submitIntegration"]>[0]) =>
                (await Repo.open(dir)).submitIntegration(args),
            };
        return new RepoEngine({
          repo,
          store,
          ...(judge ? { judge } : {}),
          ...(opts.gated !== undefined ? { gated: opts.gated } : {}),
          ...(opts.readAccess !== undefined ? { readAccess: opts.readAccess } : {}),
          ...(opts.identity !== undefined ? { identity: opts.identity } : {}),
          ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
          ...(opts.authWindowMs !== undefined ? { authWindowMs: opts.authWindowMs } : {}),
        });
      })();
      engines.set(key, e);
    }
    return e;
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      // A handler that throws is a server bug, not a protocol answer — say so as 500 and
      // keep serving. Nothing in the protocol maps to this.
      send(res, { status: 500, body: { error: String((e as Error).message) } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    // Bare operability, outside any repo prefix.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      send(res, { status: 200, body: { ok: true } });
      return;
    }

    // Everything else lives under /<org>/<repo>/… — the server picks the prefix shape
    // (docs/26 §1) and this one routes it to a per-repo engine.
    if (parts.length < 3) {
      send(res, { status: 404, body: { error: "not found — protocol paths live under /<org>/<repo>/…" } });
      return;
    }
    const [org, repoName, ...rest] = parts as [string, string, ...string[]];
    if (!TRAVERSAL_SAFE(org) || !TRAVERSAL_SAFE(repoName)) {
      send(res, { status: 400, body: { error: "org and repo must be single path segments" } });
      return;
    }
    const path = "/" + rest.join("/");
    const engine = await engineFor({ org, repo: repoName });
    const auth = req.headers.authorization;

    if (req.method === "GET") {
      // /version stays open even in token mode — capability detection must work before
      // credentials do, or a client cannot even learn how to authenticate.
      if (path === "/version") return send(res, engine.version());
      const gate = await engine.verifyRead("GET", path, "", auth);
      if (gate) return send(res, gate);
      if (path === "/have") return send(res, await engine.have());
      if (path === "/sync") return send(res, await engine.sync(url.searchParams.get("since")));
      if (path === "/refs") return send(res, await engine.refs());
      if (path === "/events") {
        const ac = new AbortController();
        req.once("close", () => ac.abort());
        return send(res, await engine.events(url.searchParams.get("since"), url.searchParams.get("timeoutMs"), { signal: ac.signal }));
      }
      if (rest[0] === "objects" && rest.length === 2) {
        return send(res, await engine.getObject(decodeURIComponent(rest[1]!)));
      }
      if (rest[0] === "integrations" && rest.length === 2) {
        return send(res, await engine.integrationLookup(decodeURIComponent(rest[1]!), url.searchParams.get("view") ?? "main"));
      }
    }

    if (req.method === "POST") {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (e) {
        send(res, { status: 413, body: { error: String((e as Error).message) } });
        return;
      }
      if (path === "/objects") return send(res, await engine.putObject(raw, auth));
      if (path === "/objects/batch") return send(res, await engine.batch(raw, auth));
      if (path === "/objects/fetch") {
        // Read-shaped despite the verb (§4-6) — gated like a read, not like a write.
        const gate = await engine.verifyRead("POST", path, raw, auth);
        if (gate) return send(res, gate);
        return send(res, await engine.fetchObjects(raw));
      }
      if (path === "/finalize") return send(res, await engine.finalize(raw, auth));
      if (path === "/integrate") return send(res, await engine.integrate(raw, auth));
    }

    // Optional endpoints this instance does not serve. 404 is the protocol's word for
    // "fall back" (§0) — never a 5xx, which the client would read as a broken server.
    send(res, { status: 404, body: { error: "not found" } });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    close: async () => {
      for (const e of engines.values()) (await e).close(); // answer parked waiters, then stop
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(res: ServerResponse, answer: Answer): void {
  const raw = JSON.stringify(answer.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(raw)),
  };
  if (answer.retryAfterSeconds !== undefined) headers["retry-after"] = String(answer.retryAfterSeconds);
  res.writeHead(answer.status, headers);
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
