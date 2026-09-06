// `/landed` — land 사실이 hub 를 건너게 하는 경로 (avcs#173, docs/26 §5-2).
//
// `/refs` 는 hub→client 한 방향이고 클라이언트는 ref 를 밀지 않는다. 거버넌스는 hub 가
// 권위이니 그 방향이 맞지만, **land 는 `avcs land` 를 실행한 replica 가 authoring 한다.**
// 그래서 반대 방향의 경로가 따로 필요하다 — 없으면 land 가 조용히 유실된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAvcsServer } from "../src/server.ts";

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("빈 hub 의 landed 는 빈 배열이다 — 없는 것과 못 읽는 것을 섞지 않는다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-landed-"));
  const s = await startAvcsServer({ dataDir });
  try {
    const res = await fetch(`${s.url}/acme/web/landed`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { landed: [] });
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST 한 land 가 GET 으로 돌아온다 — 이것이 없으면 clone 이 land 이전 트리를 낸다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-landed-rt-"));
  const s = await startAvcsServer({ dataDir });
  try {
    const put = await post(`${s.url}/acme/web/landed`, { workspaces: ["feature"] });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { landed: ["feature"] });

    const got = await fetch(`${s.url}/acme/web/landed`);
    assert.deepEqual(await got.json(), { landed: ["feature"] });
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// land 는 추가 전용이고 unland 는 없다(avcs docs/16 §5). 그래서 합집합이 안전하고, 그
// 성질이 CAS 없이 수렴을 보장한다 — 도착 순서가 결과를 바꾸지 않는다.
test("합집합이다 — 뒤에 온 POST 가 앞의 land 를 지우지 않는다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-landed-union-"));
  const s = await startAvcsServer({ dataDir });
  try {
    await post(`${s.url}/acme/web/landed`, { workspaces: ["wsA"] });
    const second = await post(`${s.url}/acme/web/landed`, { workspaces: ["wsB"] });
    assert.deepEqual(await second.json(), { landed: ["wsA", "wsB"] }, "치환이면 wsA 를 잃는다");

    // 멱등: 이미 있는 이름을 다시 보내도 집합은 그대로다.
    const again = await post(`${s.url}/acme/web/landed`, { workspaces: ["wsA"] });
    assert.deepEqual(await again.json(), { landed: ["wsA", "wsB"] });
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("landed 집합도 repo 별로 격리된다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-landed-iso-"));
  const s = await startAvcsServer({ dataDir });
  try {
    await post(`${s.url}/acme/web/landed`, { workspaces: ["feature"] });
    const other = await fetch(`${s.url}/acme/api/landed`);
    assert.deepEqual(await other.json(), { landed: [] }, "다른 repo 는 비어 있어야 한다");
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("형태가 틀린 본문은 400 이다 — 조용히 무시하지 않는다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-landed-bad-"));
  const s = await startAvcsServer({ dataDir });
  try {
    for (const body of [{ workspaces: "feature" }, { workspaces: [1, 2] }, {}]) {
      const res = await post(`${s.url}/acme/web/landed`, body);
      assert.equal(res.status, 400, `거부해야 한다: ${JSON.stringify(body)}`);
    }
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// setRef 는 SPI 에서 선택이다. 못 쓰는 백엔드는 `/landed` 를 광고하지 않는 서버가 되고,
// 404 는 프로토콜에서 "이 능력은 없다" 는 뜻이다(§0) — 5xx 가 아니다.
test("setRef 없는 백엔드에서는 POST 가 404 다 — 부분 서버는 정당하다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-landed-nosetref-"));
  const { ObjectStore } = await import("@izagood/avcs/store");
  const s = await startAvcsServer({
    dataDir,
    storageFor: async (_repo, dir) => {
      const store = new ObjectStore(dir);
      await store.init();
      // setRef 만 빼고 그대로 위임한다.
      return {
        put: (o) => store.put(o as Parameters<typeof store.put>[0]),
        putMany: (o) => store.putMany(o as Parameters<typeof store.putMany>[0]),
        get: (oid) => store.get(oid),
        has: (oid) => store.has(oid),
        listOids: () => store.listOids(),
        readObjLog: () => store.readObjLog(),
        listRefs: () => store.listRefs(),
        getRef: (n) => store.getRef(n),
      };
    },
  });
  try {
    const res = await post(`${s.url}/acme/web/landed`, { workspaces: ["feature"] });
    assert.equal(res.status, 404);
    // 읽기는 여전히 성립한다 — 그냥 비어 있을 뿐이다.
    const got = await fetch(`${s.url}/acme/web/landed`);
    assert.deepEqual(await got.json(), { landed: [] });
  } finally {
    await s.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
