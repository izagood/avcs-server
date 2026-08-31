# avcs-server

[![CI](https://github.com/izagood/avcs-server/actions/workflows/ci.yml/badge.svg)](https://github.com/izagood/avcs-server/actions/workflows/ci.yml) — the badge *is* the conformance claim: green means the avcs suite passed against a running instance.

A self-hostable, multi-repo server for the **[avcs](https://github.com/izagood/avcs)** protocol.

This is a **clean-room implementation**: it is written from the protocol documents
([26 — Server protocol](https://github.com/izagood/avcs/blob/main/docs/26-hub-protocol.md),
[24 — Canonical interop](https://github.com/izagood/avcs/blob/main/docs/24-canonical-interop.md))
and the published `@izagood/avcs` library — nothing else. The avcs **conformance suite is the
definition of done** here: a protocol level is "supported" exactly when the suite passes it
against a running instance.

```bash
AVCS_CONFORMANCE_URL=http://localhost:8420/acme/web npm run conformance   # in the avcs repo
```

## Status

| Level | Serves | Status |
|---|---|---|
| `core` | `GET /have` · `GET /objects/:oid` · `POST /objects` — enough to clone and push | ✅ conformance-verified |
| `sync` | `GET /sync` incremental cursor · `POST /objects/batch` · `POST /objects/fetch` | ✅ conformance-verified |
| `governance` | `GET /refs` distribution · `POST /finalize` head CAS | ✅ conformance-verified |
| `queue` | `POST /integrate` verdicts · `GET /integrations/:ticketId` · `GET /events` long-poll | ✅ conformance-verified |

All four levels, verified against the avcs conformance suite on every commit. The judgement
plane (finalize / integrate) is delegated to the library's `Repo` — a queue verdict must be a
pure function of objects + Protection, and a second implementation of that function is exactly
how two servers drift apart.

## Protocol only, by design — and embeddable

This package is the **protocol and nothing else**. Everything a hosted product adds on top —
accounts, quotas, metering, webhooks, custom storage — enters through three SPI seams instead
of a fork, so the protocol implementation stays in one public place and cannot drift:

```ts
import { startAvcsServer } from "@izagood/avcs-server";

await startAvcsServer({
  dataDir: "./data",
  gated: true,                        // writes require an AVCS-Sig by a resolvable member
  readAccess: "token",                // reads require a bearer token (or a member signature)
  identity: myAccountSystem,          // IdentityProvider: keys, revocation, read tokens
  hooks: {                            // product lifecycle around every write
    beforeWrite: (ev) => quota.check(ev),          // veto: 429 + retry-after, or 403
    afterWrite: (ev) => meterAndNotify(ev),        // best-effort: metering, webhooks, audit
  },
  storageFor: (repo, dir) => myBackend(repo),      // StorageBackend: default is the library's ObjectStore
  judgeFor: (repo, dir) => myJudge(repo),          // JudgementBackend: return null to not serve the plane
});
```

The engine itself is transport-agnostic — `@izagood/avcs-server/engine` exposes every endpoint
as `(raw request parts) → { status, body }`, and the stdlib binding in this repo is ~100 lines
you can reimplement on any framework. Capability flags follow composition honestly: no judge ⇒
`integrate: false` and 404s, which the protocol defines as "fall back", not "error".

Auth verification is the library's `verifyAuth` (docs/26 §7) — this server only wires the
directory. Credentials are scope-checked per repo, so a signature captured for one tenant is
refused on another. The default deployment stays open (`gated: false`, reads public), which
fits a trusted network; flip `AVCS_SERVER_GATED=1` (or the options above) for anything else.

## Run

```bash
npm install
AVCS_SERVER_DATA=./data PORT=8420 npm start
```

Repos live under `/<org>/<repo>` — no registration step, a repo exists once something is
pushed to it:

```bash
avcs remote add origin http://localhost:8420/acme/web
avcs push origin        # or: avcs sync origin
avcs clone http://localhost:8420/acme/web ./checkout
```

## What this is (and is not)

`avcs-server` is the deployable middle of the avcs world: more than the reference
`startHub` embedded in the library (single-repo, meant for tests and embedding), and
deliberately less than a hosted product — no web UI, no SSO, no CI/CD orchestration, no
billing. It stores objects, answers the protocol, and stays small enough to read.

Object identity, the canonicalization gate and group-committed durability all come from the
library — this repo adds multi-repo routing, persistence layout and the HTTP surface, and
re-derives none of the invariants.

## License

Apache-2.0
