// 자체 스모크 — 진짜 게이트는 avcs 레포의 적합성 스위트다:
//   AVCS_CONFORMANCE_URL=<이 서버>/<org>/<repo> npm run conformance
// 여기서는 서버 고유의 것만 잰다: 멀티 레포 격리와 경로 탈출 차단.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAvcsServer } from "../src/server.ts";

const OBJ = { type: "intent", title: "t", owner: "human:h", status: "open", createdAt: "2026-08-31T00:00:00.000Z" };

test("두 repo 는 서로의 객체를 보지 않는다 — 멀티테넌시의 최소 조건", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-srv-"));
  const s = await startAvcsServer({ dataDir });
  try {
    const put = await fetch(`${s.url}/acme/web/objects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OBJ),
    });
    assert.equal(put.status, 200);
    const { oid } = (await put.json()) as { oid: string };

    const same = await fetch(`${s.url}/acme/web/have`);
    assert.ok(((await same.json()) as string[]).includes(oid));

    const other = await fetch(`${s.url}/acme/api/have`);
    assert.deepEqual(await other.json(), [], "다른 repo 의 /have 는 비어 있어야 한다");
    const cross = await fetch(`${s.url}/acme/api/objects/${oid}`);
    assert.equal(cross.status, 404, "다른 repo 에서 그 oid 는 404 다");
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("경로 탈출은 라우팅에서 거부된다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-srv-"));
  const s = await startAvcsServer({ dataDir });
  try {
    for (const bad of ["/..%2F..%2Fetc/x/have", "/.hidden/repo/have", "/a/..%2E/have"]) {
      const r = await fetch(`${s.url}${bad}`);
      assert.ok([400, 404].includes(r.status), `${bad} → ${r.status}`);
    }
    // 정상 이름은 통과한다 — 거부가 전부를 막으면 이 테스트는 아무것도 재지 않는다.
    const ok = await fetch(`${s.url}/my-org/my.repo_1/have`);
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("integration 객체는 core 레벨에서도 거부한다 — 큐 히스토리 위조 방지", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-srv-"));
  const s = await startAvcsServer({ dataDir });
  try {
    const r = await fetch(`${s.url}/a/b/objects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "integration", verdict: "advanced" }),
    });
    assert.equal(r.status, 403);
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
