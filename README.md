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
how two servers drift apart. Transport auth (`AVCS-Sig`) and gated push are the remaining
roadmap: this server currently runs open (`gated: false`, `auth: "none"`), which fits a
trusted-network deployment; don't put it on the open internet yet.

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
