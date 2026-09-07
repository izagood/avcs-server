// docs/26 §6-4 · avcs docs/27 — 복제하지 않는 클라이언트가 판정과 트리 지도를 읽는다.
// 계약은 "같은 객체로 로컬 환원한 것과 같은가" 다. 이 서버는 reduce() 를 대신 부를 뿐이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo, MATERIALIZER_VERSION } from "@izagood/avcs";
import { pushToHub } from "@izagood/avcs/hub/client";
import { startAvcsServer, type AvcsServerOpts, type ReductionBackend, type Reduction } from "../src/server.ts";

type Reduced = {
  view: string; cursor: number; materializer: string; treeHash: string;
  statuses: Record<string, string>; headOps: string[]; tree?: Record<string, string>; synth?: string[]; treeOmitted: boolean;
};

const human = { kind: "human" as const, id: "human:t" };

/** 서버 하나 + (기본) 파일 둘을 push 한 replica. `seed: false` 면 서버만 띄운다. */
async function rig(opts: Partial<AvcsServerOpts> = {}, { seed = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-server-red-"));
  const work = await mkdtemp(join(tmpdir(), "avcs-server-red-work-"));
  const server = await startAvcsServer({ dataDir, ...opts });
  const base = `${server.url}/acme/web`;
  const repo = await Repo.openOrInit(work);
  if (seed) {
    await writeFile(join(work, "a.txt"), "hello\n");
    await writeFile(join(work, "b.txt"), "world\n");
    await repo.commitWorkingTree(work, { message: "seed", actor: human });
    await pushToHub(work, base);
  }
  return {
    base, repo, work,
    cleanup: async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); },
  };
}

const get = (base: string, view = "main", headers: Record<string, string> = {}) =>
  fetch(`${base}/reduced?view=${encodeURIComponent(view)}`, { headers });

test("/version 은 materializer 를 항상, reduced 와 reducedTreeMaxEntries 를 기본 구성에서 광고한다", async () => {
  const s = await rig({}, { seed: false });
  try {
    const v = (await (await fetch(`${s.base}/version`)).json()) as Record<string, unknown>;
    assert.equal(v.materializer, MATERIALIZER_VERSION, "docs/26 §3 의 필드 — 지금까지 누락돼 있었다");
    assert.equal(v.reduced, true);
    assert.equal(v.reducedTreeMaxEntries, 50_000);
    assert.equal(v.protocol, 5);
  } finally { await s.cleanup(); }
});

test("GET /reduced 는 로컬 환원과 같은 treeHash·statuses·tree 를 주고 cursor 는 /sync 와 같다", async () => {
  const s = await rig();
  try {
    const want = await s.repo.materialize("main");
    const res = await get(s.base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("etag") ?? "", /^"[0-9a-f]{32}"$/);
    const j = (await res.json()) as Reduced;
    assert.equal(j.view, "main");
    assert.equal(j.treeHash, want.treeHash);
    assert.deepEqual(j.statuses, Object.fromEntries(want.statuses));
    assert.deepEqual(j.tree, Object.fromEntries(want.tree));
    assert.deepEqual(j.synth, []);
    assert.equal(j.treeOmitted, false);
    assert.equal(j.materializer, MATERIALIZER_VERSION);
    const sync = (await (await fetch(`${s.base}/sync?since=0`)).json()) as { cursor: number };
    assert.equal(j.cursor, sync.cursor);
  } finally { await s.cleanup(); }
});

test("If-None-Match 일치는 304 본문 없음; push 뒤에는 ETag 가 바뀐다", async () => {
  const s = await rig();
  try {
    const first = await get(s.base);
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();
    const again = await get(s.base, "main", { "if-none-match": etag });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("etag"), etag);
    assert.equal(await again.text(), "");
    await writeFile(join(s.work, "c.txt"), "!\n");
    await s.repo.commitWorkingTree(s.work, { message: "more", actor: human });
    await pushToHub(s.work, s.base);
    const after = await get(s.base, "main", { "if-none-match": etag });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.get("etag"), etag);
    assert.ok("c.txt" in ((await after.json()) as Reduced).tree!);
  } finally { await s.cleanup(); }
});

test("없는 view 는 404, view 생략은 main", async () => {
  const s = await rig();
  try {
    assert.equal((await get(s.base, "nope")).status, 404);
    const bare = await fetch(`${s.base}/reduced`);
    assert.equal(bare.status, 200);
    assert.equal(((await bare.json()) as Reduced).view, "main");
  } finally { await s.cleanup(); }
});

test("tree 상한 초과는 잘라 주지 않고 뺀다 — 판정은 온전, 상한은 광고된다", async () => {
  const s = await rig({ reducedTreeMaxEntries: 1 });
  try {
    const v = (await (await fetch(`${s.base}/version`)).json()) as { reducedTreeMaxEntries: number };
    assert.equal(v.reducedTreeMaxEntries, 1);
    const j = (await (await get(s.base)).json()) as Reduced;
    assert.equal(j.treeOmitted, true);
    assert.equal(j.tree, undefined);
    assert.equal(j.synth, undefined);
    assert.equal(Object.keys(j.statuses).length, 2);
  } finally { await s.cleanup(); }
});

test("백엔드가 없으면 /reduced 는 404 이고 reduced: false, reducedTreeMaxEntries 는 없다 — §0 의 부분 구현", async () => {
  const s = await rig({ reduceFor: async () => null });
  try {
    const v = (await (await fetch(`${s.base}/version`)).json()) as Record<string, unknown>;
    assert.equal(v.reduced, false);
    assert.equal("reducedTreeMaxEntries" in v, false, "reduced 가 거짓이면 상한도 없다");
    assert.equal(v.materializer, MATERIALIZER_VERSION, "materializer 는 백엔드와 무관하게 항상");
    assert.equal(v.integrate, true, "판정 평면은 독립이다 — 여기서는 살아 있다");
    assert.equal((await get(s.base)).status, 404);
    assert.equal((await fetch(`${s.base}/reduced/blob/blob_${"0".repeat(32)}?view=main`)).status, 404);
  } finally { await s.cleanup(); }
});

test("커스텀 ReductionBackend: 캐시 히트에서는 reduce 를 다시 부르지 않고, 변경 뒤에만 부른다", async () => {
  let calls = 0;
  const fake: Reduction = {
    treeHash: "f".repeat(64), statuses: { operation_aa: "accepted" }, headOps: ["operation_aa"],
    conflicts: [], fileConflicts: [], blockedReasons: {}, untrustedEvidence: 0,
    tree: { "x.txt": "blob_" + "1".repeat(32) }, synth: {},
  };
  const backend: ReductionBackend = { reduce: async ({ view }) => { calls++; return view === "main" ? fake : null; } };
  const s = await rig({ reduceFor: async () => backend });
  try {
    const first = await get(s.base);
    const etag = first.headers.get("etag")!;
    assert.equal(((await first.json()) as Reduced).treeHash, "f".repeat(64), "엔진은 백엔드의 답을 그대로 실어 준다 — 재판정하지 않는다");
    const after1 = calls;
    assert.equal(after1, 1, "환원 앞뒤 ETag 가 같으니 한 번이면 된다");
    for (let i = 0; i < 3; i++) await (await get(s.base)).arrayBuffer();
    await (await get(s.base, "main", { "if-none-match": etag })).arrayBuffer();
    assert.equal(calls, after1, "같은 ETag 면 환원 0회");
    await writeFile(join(s.work, "c.txt"), "!\n");
    await s.repo.commitWorkingTree(s.work, { message: "more", actor: human });
    await pushToHub(s.work, s.base);
    await (await get(s.base)).arrayBuffer();
    assert.ok(calls > after1, "객체가 늘면 다시 부른다");
    assert.equal((await get(s.base, "other")).status, 404, "백엔드의 null 은 404 다");
  } finally { await s.cleanup(); }
});

test("합성 blob: synth 에 있고 /objects 에는 없고 /reduced/blob 에서 200; 저장된 blob 은 404; If-Match 불일치 412", async () => {
  const s = await rig({}, { seed: false });
  try {
    const ai = { kind: "ai_agent" as const, id: "ai:a" };
    const intent = await s.repo.createIntent({ title: "merge", owner: human.id });
    const sess = await s.repo.startSession({ intentOid: intent, actor: ai });
    const baseText = "one\ntwo\nthree\nfour\nfive\n";
    const b = await s.repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "m.txt", content: baseText, declaredPurpose: "base" });
    await s.repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: ai, path: "m.txt", baseText, newText: "ONE\ntwo\nthree\nfour\nfive\n", declaredPurpose: "h", causalDeps: [b] });
    await s.repo.proposeEdit({ sessionOid: sess, intentOid: intent, actor: human, path: "m.txt", baseText, newText: "one\ntwo\nthree\nfour\nFIVE\n", declaredPurpose: "t", causalDeps: [b] });
    await pushToHub(s.work, s.base);
    const want = await s.repo.materialize("main");
    const synthOid = want.tree.get("m.txt")!;
    assert.ok(want.synthBlobs.has(synthOid), "시드가 합성 blob 을 만들어야 한다");

    const res = await get(s.base);
    const etag = res.headers.get("etag")!;
    const j = (await res.json()) as Reduced;
    assert.deepEqual(j.synth, [synthOid]);
    assert.equal((await fetch(`${s.base}/objects/${synthOid}`)).status, 404, "합성 blob 은 저장소에 없다 — 있어서도 안 된다");
    const blob = await fetch(`${s.base}/reduced/blob/${synthOid}?view=main`, { headers: { "if-match": etag } });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get("etag"), etag);
    const body = (await blob.json()) as { oid: string; data: string; encoding: string };
    assert.equal(body.oid, synthOid);
    assert.equal(body.encoding, "base64");
    assert.equal(Buffer.from(body.data, "base64").toString("utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");

    const stored = await s.repo.putBlob(baseText);
    assert.equal((await fetch(`${s.base}/reduced/blob/${stored}?view=main`)).status, 404, "저장된 blob 은 /objects 로 가라 — 두 경로는 겹치지 않는다");
    const stale = await fetch(`${s.base}/reduced/blob/${synthOid}?view=main`, { headers: { "if-match": '"' + "0".repeat(32) + '"' } });
    assert.equal(stale.status, 412);
    assert.equal(stale.headers.get("etag"), etag, "412 는 현재 ETag 를 알려 준다");
    assert.equal((await fetch(`${s.base}/reduced/blob/${synthOid}?view=nope`)).status, 404);
  } finally { await s.cleanup(); }
});

test("readAccess token: /reduced 도 다른 읽기와 같은 게이트를 탄다", async () => {
  const s = await rig(
    { readAccess: "token", identity: { resolvePublicKey: async () => null, verifyReadToken: async (_r, t) => t === "ok" } },
    { seed: false },
  );
  try {
    assert.equal((await get(s.base)).status, 401);
    assert.equal((await fetch(`${s.base}/reduced/blob/blob_${"0".repeat(32)}?view=main`)).status, 401);
    // 빈 저장소의 main 도 Repo.materialize 가 시드하므로 200 이다.
    assert.equal((await get(s.base, "main", { authorization: "Bearer ok" })).status, 200);
  } finally { await s.cleanup(); }
});
