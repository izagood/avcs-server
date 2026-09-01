# avcs-server

[![CI](https://github.com/izagood/avcs-server/actions/workflows/ci.yml/badge.svg)](https://github.com/izagood/avcs-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@izagood/avcs-server.svg)](https://www.npmjs.com/package/@izagood/avcs-server)
[![node](https://img.shields.io/node/v/@izagood/avcs-server.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A self-hostable, multi-repo server for the **[avcs](https://github.com/izagood/avcs)** protocol —
and, for anyone building on top of it, a transport-agnostic protocol engine with SPI seams.

The avcs **conformance suite is the definition of done** here: a protocol level is "supported"
exactly when the suite passes against a running instance. CI runs it on every commit, so the
green badge above *is* the compatibility claim.

## Quick start

Run a server (no config, no registration step):

```bash
npx @izagood/avcs-server
# avcs-server listening at http://0.0.0.0:8420  (data: ./data)
```

Point a client at it. A repo lives at `/<org>/<repo>` and exists as soon as something is pushed:

```bash
avcs remote add origin http://localhost:8420/acme/web
avcs push origin                                          # or: avcs sync origin
avcs clone http://localhost:8420/acme/web ./checkout
```

### Configuration

The CLI is configured entirely by environment:

| Variable | Default | Meaning |
|---|---|---|
| `AVCS_SERVER_DATA` | `./data` | Data root — one object store per `<org>/<repo>` |
| `PORT` | `8420` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `AVCS_SERVER_GATED` | unset | `1` ⇒ writes require a valid `AVCS-Sig` by a resolvable member |

The default deployment is open (writes unsigned, reads public), which fits a trusted network.
Anything else should set `AVCS_SERVER_GATED=1`, whose member directory is core-native:
`member:<keyId>` refs pointing at Membership objects already in the store. Read tokens, custom
key directories and product hooks are for embedders — see [Embedding](#embedding).

## Protocol support

Every level below is verified by the avcs conformance suite in CI, with zero skips.

| Level | Endpoints | Status |
|---|---|---|
| `core` | `GET /have` · `GET /objects/:oid` · `POST /objects` | ✅ conformance-verified |
| `sync` | `GET /sync` (incremental cursor) · `POST /objects/batch` · `POST /objects/fetch` | ✅ conformance-verified |
| `governance` | `GET /refs` · `POST /finalize` (head CAS) | ✅ conformance-verified |
| `queue` | `POST /integrate` · `GET /integrations/:ticketId` · `GET /events` (long-poll) | ✅ conformance-verified |

`GET /version` advertises the capabilities actually composed in, and `GET /healthz` answers
outside any repo prefix. To re-run the suite against your own instance, from a checkout of the
[avcs](https://github.com/izagood/avcs) repo:

```bash
AVCS_CONFORMANCE_URL=http://localhost:8420/acme/web npm run conformance
```

The judgement plane (`finalize` / `integrate`) is delegated to the avcs library's `Repo`: a queue
verdict must be a pure function of objects + Protection, and a second implementation of that
function is exactly how two servers drift apart.

## Embedding

This package is the protocol and nothing else. Everything a hosted product adds on top —
accounts, quotas, metering, webhooks, custom storage — enters through SPI seams instead of a
fork, so the protocol implementation stays in one place and cannot drift:

```ts
import { startAvcsServer } from "@izagood/avcs-server";

await startAvcsServer({
  dataDir: "./data",
  gated: true,                     // writes require an AVCS-Sig by a resolvable member
  readAccess: "token",             // reads require a bearer token (or a member signature)
  identity: myAccountSystem,       // IdentityProvider: keys, revocation, read tokens
  hooks: {                         // product lifecycle around every write
    beforeWrite: (ev) => quota.check(ev),      // veto: 402 / 403 / 429 (+ retry-after)
    afterWrite: (ev) => meterAndNotify(ev),    // best-effort: metering, webhooks, audit
  },
  storageFor: (repo, dir) => myBackend(repo),  // StorageBackend: default is the library's ObjectStore
  judgeFor: (repo, dir) => myJudge(repo),      // JudgementBackend: return null to not serve the plane
});
```

| Export | What it gives you |
|---|---|
| `@izagood/avcs-server` | `startAvcsServer(opts)` — the stdlib http server, batteries included |
| `@izagood/avcs-server/engine` | `RepoEngine` — every endpoint as `(raw request parts) → { status, body }` |
| `@izagood/avcs-server/spi` | The seam types: `StorageBackend`, `JudgementBackend`, `IdentityProvider`, `Hooks` |

The engine has no `node:http` and no framework in it, so binding it to Fastify, Express or a
serverless handler means reimplementing [`src/server.ts`](./src/server.ts) — about 100 lines of
URL parsing and body collection — and none of the protocol.

Capability flags follow composition honestly: no judge ⇒ `integrate: false` and a 404, which the
protocol defines as "fall back", not "error". Auth verification is the library's `verifyAuth`
(docs/26 §7); this server only wires the directory, and credentials are scope-checked per repo so
a signature captured for one tenant is refused on another.

## What this is (and is not)

`avcs-server` is the deployable middle of the avcs world: more than the reference `startHub`
embedded in the library (single-repo, meant for tests and embedding), and deliberately less than
a hosted product — no web UI, no SSO, no CI/CD orchestration, no billing. It stores objects,
answers the protocol, and stays small enough to read.

It is an independent implementation, written from the protocol documents
([26 — Server protocol](https://github.com/izagood/avcs/blob/main/docs/26-hub-protocol.md),
[24 — Canonical interop](https://github.com/izagood/avcs/blob/main/docs/24-canonical-interop.md))
and the published `@izagood/avcs` library. Object identity, the canonicalization gate and
group-committed durability all come from the library — this repo adds multi-repo routing,
persistence layout and the HTTP surface, and re-derives none of the invariants.

## Development

Requires Node **≥ 22.6** (TypeScript runs directly via type stripping — no build step for dev).

```bash
git clone https://github.com/izagood/avcs-server.git && cd avcs-server
npm ci
npm test          # unit + level tests
npm run typecheck
npm start         # AVCS_SERVER_DATA=./data PORT=8420 by default
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:` and `fix:`
on `main` publish a release automatically. Issues and PRs are welcome at
[izagood/avcs-server](https://github.com/izagood/avcs-server/issues); protocol questions belong
in the [avcs](https://github.com/izagood/avcs) repo.

## License

Apache-2.0
