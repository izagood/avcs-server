// The seams a consumer plugs product concerns into. avcs-server itself is protocol only —
// docs/26 is the whole scope — and everything a hosted product adds (accounts, quotas,
// metering, webhooks, custom storage) enters through these three interfaces instead of a
// fork. The engine calls them; it never knows what is behind them.

/** One tenant repository, as the URL prefix names it. */
export interface RepoRef {
  org: string;
  repo: string;
}

/**
 * The object-plane storage the engine consumes. The default backend is the library's
 * `ObjectStore` (file-based, group-committed durability, the canonical interop gate inside
 * `put`/`putMany`) — a custom backend must honor the same contracts, and the conformance
 * suite pointed at the composed server is how you prove it did:
 *
 *  - `put`/`putMany` recompute the content address (a claimed oid is never trusted, docs/26 §8)
 *    and REFUSE interop-unsafe values (docs/24 §3) by throwing.
 *  - `readObjLog` is append-ordered and never reordered — its index is the /sync and /events
 *    cursor (docs/26 §4-2), and reordering breaks every client's incremental state.
 *  - refs are the governance plane (docs/26 §5): `listRefs` is what /refs serves.
 */
export interface StorageBackend {
  put(obj: object): Promise<string>;
  putMany(objects: object[]): Promise<{ oid: string; existed: boolean }[]>;
  get(oid: string): Promise<unknown>;
  has(oid: string): Promise<boolean>;
  listOids(): Promise<string[]>;
  readObjLog(): Promise<string[]>;
  listRefs(): Promise<Map<string, string>>;
  getRef(name: string): Promise<string | null>;
}

/**
 * The judgement plane (docs/26 §6). The default wraps the library's `Repo` on the repo's
 * data directory — the queue verdict must be a pure function of objects + Protection, and a
 * second implementation of that function is exactly how two servers drift apart, so this
 * interface exists for *routing* (e.g. a remote judgement service), not for re-deciding.
 *
 * A deployment whose storage cannot host the library `Repo` (an object store with no
 * filesystem) simply provides no judge: /finalize and /integrate then answer 404 and the
 * capability flags say `integrate: false` — a partial server is a first-class one (§0).
 */
export interface JudgementBackend {
  finalize(args: { view: string; newCheckpoint: string; parentHead: string | null; by: string }): Promise<
    { finalized: true; head: string } | { finalized: false; reason: string }
  >;
  submitIntegration(args: { view: string; checkpoint: string; by: string; ticketId?: string }): Promise<{
    verdict: "advanced" | "queued" | "conflict" | "needs_evidence" | "rejected" | string;
    [k: string]: unknown;
  }>;
}

/**
 * Who may write, and who may read. The engine owns the AVCS-Sig *verification* (docs/26 §7 —
 * the library's `verifyAuth` is the canonical implementation and this server only wires it);
 * this interface owns the *directory* the verification consults.
 *
 * The default is core-native: `member:<keyId>` refs pointing at Membership objects in the
 * store. A hosted product replaces it with its own account system — key revocation, SSO
 * linkage, whatever it keeps — without the engine knowing.
 */
export interface IdentityProvider {
  /** Public key for a member keyId, or null when unknown/revoked (verification then fails 401). */
  resolvePublicKey(repo: RepoRef, keyId: string): Promise<string | null>;
  /**
   * Validate a read-only bearer token (docs/26 §7, `Authorization: Bearer`). Only consulted
   * when the server runs with `readAccess: "token"`. Absent ⇒ every bearer read is refused
   * in that mode (a token directory is exactly what the consumer must supply).
   */
  verifyReadToken?(repo: RepoRef, token: string): Promise<boolean>;
}

/** What a mutation is, before the engine performs it. */
export interface WriteEvent {
  repo: RepoRef;
  kind: "objects" | "objects/batch" | "finalize" | "integrate";
  /** Verified signer keyId when the server is gated; absent on an open server. */
  actor?: string;
  /** Objects in the request (1 except for a batch). */
  count: number;
  /** JSON bytes of the incoming object(s) — what a plan/quota check projects forward. */
  bytes: number;
}

/** A pre-hook refusal. The status is the hook's choice: 429 throttles (with retry-after),
 *  403 refuses outright, 402 is a product's plan/quota refusal — all end up as plain
 *  `{ error }` answers, which is all the protocol requires of an error (docs/26 §4-4). */
export interface WriteVeto {
  ok: false;
  status: 402 | 403 | 429;
  error: string;
  retryAfterSeconds?: number;
  /** Extra fields to carry in the error body (e.g. a quota's violations list). */
  details?: Record<string, unknown>;
}

/** Per-object summary an afterWrite hook receives — enough for metering (bytes), routing
 *  (type) and audit (oid) without re-reading the store. */
export interface StoredObject {
  oid: string;
  type: string;
  bytes: number;
}

/**
 * Product lifecycle around the protocol. `beforeWrite` may veto (quota, rate policy);
 * `afterWrite` observes what happened (metering, webhooks, notifications, audit) and is
 * best-effort by contract: it runs after the mutation is durable, and a hook failure is
 * the product's problem, never the protocol answer's.
 */
export interface Hooks {
  beforeWrite?(ev: WriteEvent): Promise<{ ok: true } | WriteVeto> | { ok: true } | WriteVeto;
  afterWrite?(ev: WriteEvent & { stored: StoredObject[]; verdict?: string }): void | Promise<void>;
}

/** One protocol answer, transport-agnostic. A binding maps it onto its framework. */
export interface Answer {
  status: number;
  body: unknown;
  /** Set on a 429 — the binding must surface it as the `retry-after` header (§4-4). */
  retryAfterSeconds?: number;
}
