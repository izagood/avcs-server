// sync · governance · queue 평면 테스트.
//
// 시드는 손으로 심지 않는다 — 실제 클라이언트 경로(Repo.openOrInit → commitWorkingTree →
// createCheckpoint → pushToHub)로 만든다. 손으로 심은 상태는 실제 경로에서 불가능한 순서를
// 재게 될 수 있다(#55 의 첫 재현이 그랬다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "@izagood/avcs";
import { pushToHub } from "@izagood/avcs/hub/client";
import { startAvcsServer, type AvcsServerHandle } from "../src/server.ts";

async function seededServer(): Promise<{
  server: AvcsServerHandle; base: string; work: string; checkpoint: string; cleanup(): Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-server-data-"));
  const work = await mkdtemp(join(tmpdir(), "avcs-server-work-"));
  const server = await startAvcsServer({ dataDir });
  const base = `${server.url}/acme/web`;

  const repo = await Repo.openOrInit(work);
  await writeFile(join(work, "a.txt"), "hello\n");
  await repo.commitWorkingTree(work, { message: "seed", actor: { kind: "human", id: "human:t" } });
  const checkpoint = await repo.createCheckpoint("main", "seed checkpoint");
  await pushToHub(work, base);

  return {
    server, base, work, checkpoint,
    cleanup: async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    },
  };
}

// ── sync ──────────────────────────────────────────────────────────────────────

test("sync: /sync 커서가 증분을 만들고, 범위 밖이면 전량이다", async () => {
  const s = await seededServer();
  try {
    const first = await (await fetch(`${s.base}/sync?since=0`)).json() as { oids: string[]; cursor: number };
    assert.ok(first.oids.length > 0, "시드가 밀려 있어야 한다");
    assert.equal(first.cursor, first.oids.length, "커서는 objlog 길이다");

    const again = await (await fetch(`${s.base}/sync?since=${first.cursor}`)).json() as { oids: string[]; cursor: number };
    assert.deepEqual(again.oids, []);
    assert.equal(again.cursor, first.cursor);

    const wild = await (await fetch(`${s.base}/sync?since=999999`)).json() as { oids: string[] };
    assert.deepEqual(wild.oids, first.oids, "범위 밖 커서는 전량");
  } finally { await s.cleanup(); }
});

test("sync: /objects/fetch 는 없는 oid 를 조용히 빼고, 형태가 틀리면 400", async () => {
  const s = await seededServer();
  try {
    const have = await (await fetch(`${s.base}/have`)).json() as string[];
    const missing = "intent_" + "0".repeat(32);
    const res = await fetch(`${s.base}/objects/fetch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ oids: [...have.slice(0, 3), missing] }),
    });
    assert.equal(res.status, 200);
    const j = await res.json() as { objects: { oid?: string }[]; truncated: boolean };
    assert.equal(j.objects.length, 3, "있는 3개만 온다");
    assert.equal(j.truncated, false);

    const bad = await fetch(`${s.base}/objects/fetch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nope: 1 }),
    });
    assert.equal(bad.status, 400);
  } finally { await s.cleanup(); }
});

test("sync: /objects/batch 는 객체마다 판정한다 — integration 만 거부되고 나머지는 저장된다", async () => {
  const s = await seededServer();
  try {
    const have = await (await fetch(`${s.base}/have`)).json() as string[];
    const existing = await (await fetch(`${s.base}/objects/${have[0]}`)).json() as Record<string, unknown>;
    const res = await fetch(`${s.base}/objects/batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objects: [existing, { type: "integration", view: "main" }] }),
    });
    assert.equal(res.status, 200, "배치 자체는 200 — 판정은 본문에");
    const j = await res.json() as { results: { status: string; reason?: string }[] };
    assert.equal(j.results.length, 2);
    assert.equal(j.results[0]!.status, "stored", "재전송은 멱등 저장");
    assert.equal(j.results[1]!.status, "rejected", "integration 은 밀 수 없다");

    const bad = await fetch(`${s.base}/objects/batch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oids: [] }),
    });
    assert.equal(bad.status, 400, "{ objects: [...] } 가 아니면 400");
  } finally { await s.cleanup(); }
});

// ── governance ───────────────────────────────────────────────────────────────

test("governance: /finalize 가 head 를 전진시키고 /refs 에 보인다", async () => {
  const s = await seededServer();
  try {
    const res = await fetch(`${s.base}/finalize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "main", newCheckpoint: s.checkpoint, parentHead: null, by: "human:t" }),
    });
    const body = await res.json() as { finalized?: boolean; reason?: string };
    assert.equal(res.status, 200, `finalize 실패: ${body.reason ?? ""}`);
    assert.equal(body.finalized, true);

    const refs = (await (await fetch(`${s.base}/refs`)).json() as { refs: Record<string, string> }).refs;
    assert.equal(refs["head:main"], s.checkpoint, "head:main 이 체크포인트를 가리킨다");
  } finally { await s.cleanup(); }
});

// ── queue ────────────────────────────────────────────────────────────────────

test("queue: /integrate — 없는 체크포인트는 422 rejected, 있는 것은 advanced 로 랜딩하고 재제출은 판정을 재생한다", async () => {
  const s = await seededServer();
  try {
    const missing = await fetch(`${s.base}/integrate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "main", checkpoint: "checkpoint_" + "0".repeat(32), by: "human:t" }),
    });
    assert.equal(missing.status, 422);
    assert.equal(((await missing.json()) as { verdict: string }).verdict, "rejected");

    const submit = () => fetch(`${s.base}/integrate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "main", checkpoint: s.checkpoint, by: "human:t", ticketId: "t-1" }),
    });
    const first = await submit();
    const fj = await first.json() as { verdict: string; head?: string; reason?: string };
    assert.equal(first.status, 200, `integrate 실패: ${fj.reason ?? fj.verdict}`);
    assert.equal(fj.verdict, "advanced");

    const replay = await submit();
    assert.equal(replay.status, 200, "같은 티켓 재제출은 판정 재생");
    assert.equal(((await replay.json()) as { verdict: string }).verdict, "advanced");

    const lookup = await fetch(`${s.base}/integrations/t-1?view=main`);
    assert.equal(lookup.status, 200, "티켓 조회는 멱등 판정 재생");
  } finally { await s.cleanup(); }
});

test("queue: /events — 따라잡은 커서는 하트비트, 새 객체는 파킹을 깨운다, refs 는 매 응답에 있다", async () => {
  const s = await seededServer();
  try {
    const sync = await (await fetch(`${s.base}/sync?since=0`)).json() as { cursor: number };

    const beat = await (await fetch(`${s.base}/events?since=${sync.cursor}&timeoutMs=200`)).json() as
      { cursor: number; oids: string[]; refs?: unknown };
    assert.deepEqual(beat.oids, [], "따라잡았으면 빈 목록 하트비트");
    assert.ok(beat.refs !== undefined, "refs 는 매 응답에 탄다");

    // 파킹된 waiter 가 새 push 로 깨어나는가 — 타임아웃(5s)보다 훨씬 먼저 와야 한다.
    const parked = fetch(`${s.base}/events?since=${sync.cursor}&timeoutMs=5000`);
    await new Promise((r) => setTimeout(r, 50)); // 파킹될 틈
    const have = await (await fetch(`${s.base}/have`)).json() as string[];
    const obj = await (await fetch(`${s.base}/objects/${have[0]}`)).json() as { type: string };
    // 재전송은 멱등이지만 wake 는 일어난다(참조 구현과 같은 계약) — 새 객체 대신 재전송으로 깨운다.
    await fetch(`${s.base}/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
    const started = Date.now();
    const woken = await (await parked).json() as { oids: string[] };
    assert.ok(Date.now() - started < 4000, "타임아웃이 아니라 wake 로 풀려야 한다");
  } finally { await s.cleanup(); }
});
