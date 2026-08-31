// SPI 경계 테스트 — 게이팅·읽기 토큰·훅·판정 평면 탈착.
//
// 각 축에 양성·음성 대조를 함께 둔다: "거부됐다" 만 재면 다른 원인의 거부(경로 오타,
// 형태 오류)와 구분되지 않는다 — 같은 축에서 통과하는 요청이 함께 있어야 단언이 그
// 축을 재고 있다는 증거다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthHeader, generateKeypair } from "@izagood/avcs";
import { ObjectStore } from "@izagood/avcs/store";
import { startAvcsServer, type AvcsServerOpts, type StoredObject, type WriteEvent } from "../src/server.ts";

async function server(opts: Partial<AvcsServerOpts>) {
  const dataDir = await mkdtemp(join(tmpdir(), "avcs-server-spi-"));
  const handle = await startAvcsServer({ dataDir, ...opts });
  return {
    base: `${handle.url}/acme/web`,
    dataDir,
    cleanup: async () => {
      await handle.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const OBJ = JSON.stringify({ type: "intent", title: "hello" });

function signedHeaders(keyId: string, privateKey: string, path: string, body: string, scope: string) {
  return {
    "content-type": "application/json",
    authorization: buildAuthHeader({ keyId, privateKey, method: "POST", path, body, scope }),
  };
}

// ── gated push (docs/26 §7) ──────────────────────────────────────────────────

test("gated: 서명 없는 push 는 401, 등록된 멤버의 서명은 200, 모르는 키는 401", async () => {
  const kp = generateKeypair();
  const s = await server({
    gated: true,
    identity: {
      resolvePublicKey: async (_repo, keyId) => (keyId === "human:t" ? kp.publicKey : null),
    },
  });
  try {
    const bare = await fetch(`${s.base}/objects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: OBJ,
    });
    assert.equal(bare.status, 401, "서명이 없으면 401 이다");

    const ok = await fetch(`${s.base}/objects`, {
      method: "POST", headers: signedHeaders("human:t", kp.privateKey, "/objects", OBJ, "/acme/web"), body: OBJ,
    });
    assert.equal(ok.status, 200, `멤버 서명은 통과해야 한다: ${JSON.stringify(await ok.clone().json())}`);

    const stranger = generateKeypair();
    const bad = await fetch(`${s.base}/objects`, {
      method: "POST", headers: signedHeaders("human:x", stranger.privateKey, "/objects", OBJ, "/acme/web"), body: OBJ,
    });
    assert.equal(bad.status, 401, "리졸버가 모르는 키는 검증 불가 = 401 이다");
  } finally { await s.cleanup(); }
});

test("gated: 다른 repo 를 향해 서명한 자격증명은 거부된다 (scope, issue #49 의 서버측)", async () => {
  const kp = generateKeypair();
  const s = await server({
    gated: true,
    identity: { resolvePublicKey: async () => kp.publicKey },
  });
  try {
    const wrong = await fetch(`${s.base}/objects`, {
      method: "POST", headers: signedHeaders("human:t", kp.privateKey, "/objects", OBJ, "/acme/other"), body: OBJ,
    });
    assert.equal(wrong.status, 401, "다른 테넌트용 자격증명 재생은 거부돼야 한다");

    const right = await fetch(`${s.base}/objects`, {
      method: "POST", headers: signedHeaders("human:t", kp.privateKey, "/objects", OBJ, "/acme/web"), body: OBJ,
    });
    assert.equal(right.status, 200, "같은 축의 양성 대조 — 올바른 scope 는 통과한다");
  } finally { await s.cleanup(); }
});

test("gated: 코어 네이티브 멤버십 — member:<keyId> ref 가 가리키는 Membership 이 디렉터리다", async () => {
  const kp = generateKeypair();
  const s = await server({ gated: true });
  try {
    // 실제 경로로 심는다: 서버 스토어에 Membership 을 넣고 ref 를 세운다 — /refs 가
    // 배포하는 바로 그 형태 (docs/26 §5).
    const store = new ObjectStore(join(s.dataDir, "acme", "web"));
    await store.init();
    const oid = await store.put({ type: "membership", actorId: "human:t", publicKey: kp.publicKey, status: "active" } as never);
    await store.setRef("member:human:t", oid);

    const ok = await fetch(`${s.base}/objects`, {
      method: "POST", headers: signedHeaders("human:t", kp.privateKey, "/objects", OBJ, "/acme/web"), body: OBJ,
    });
    assert.equal(ok.status, 200, `ref 로 등록된 멤버는 통과: ${JSON.stringify(await ok.clone().json())}`);

    const stranger = generateKeypair();
    const bad = await fetch(`${s.base}/objects`, {
      method: "POST", headers: signedHeaders("human:x", stranger.privateKey, "/objects", OBJ, "/acme/web"), body: OBJ,
    });
    assert.equal(bad.status, 401, "ref 가 없는 keyId 는 401");
  } finally { await s.cleanup(); }
});

// ── 읽기 토큰 (docs/26 §7 Bearer) ────────────────────────────────────────────

test("readAccess=token: 맨몸 읽기는 401, 유효한 Bearer 는 200, /version 은 항상 열려 있다", async () => {
  const s = await server({
    readAccess: "token",
    identity: {
      resolvePublicKey: async () => null,
      verifyReadToken: async (_repo, token) => token === "s3cret",
    },
  });
  try {
    assert.equal((await fetch(`${s.base}/have`)).status, 401, "토큰 모드의 맨몸 읽기는 401");
    assert.equal((await fetch(`${s.base}/version`)).status, 200, "능력 협상은 자격증명보다 먼저다");
    const ok = await fetch(`${s.base}/have`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200, "유효한 토큰은 통과");
    const bad = await fetch(`${s.base}/have`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(bad.status, 401, "틀린 토큰은 401");
    // 읽기 성격의 POST(/objects/fetch) 도 읽기로 게이트된다
    const fetchBare = await fetch(`${s.base}/objects/fetch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oids: [] }),
    });
    assert.equal(fetchBare.status, 401, "fetch 는 동사가 POST 여도 읽기다");
  } finally { await s.cleanup(); }
});

// ── 훅 (제품 수명주기) ───────────────────────────────────────────────────────

test("hooks: beforeWrite 거부는 요청을 막고 retry-after 를 나르고, 허용 요청은 afterWrite 에 저장된 oid 로 보인다", async () => {
  const seen: (WriteEvent & { stored: StoredObject[] })[] = [];
  let veto = true;
  const s = await server({
    hooks: {
      beforeWrite: (ev) =>
        veto && ev.kind === "objects"
          ? { ok: false as const, status: 429 as const, error: "quota exceeded", retryAfterSeconds: 7 }
          : { ok: true as const },
      afterWrite: (ev) => { seen.push(ev); },
    },
  });
  try {
    const blocked = await fetch(`${s.base}/objects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: OBJ,
    });
    assert.equal(blocked.status, 429, "pre-hook 거부는 프로토콜 응답(§4-4)으로 나간다");
    assert.equal(blocked.headers.get("retry-after"), "7", "retry-after 헤더가 실려야 한다");
    assert.equal(seen.length, 0, "거부된 쓰기는 afterWrite 에 보이지 않는다");

    veto = false;
    const ok = await fetch(`${s.base}/objects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: OBJ,
    });
    assert.equal(ok.status, 200);
    const { oid } = await ok.json() as { oid: string };
    assert.equal(seen.length, 1, "성공한 쓰기는 afterWrite 로 관측된다");
    assert.deepEqual(seen[0]!.stored.map((s) => s.oid), [oid], "관측된 oid 는 저장된 그 oid 다");
    assert.equal(seen[0]!.stored[0]!.type, "intent", "라우팅용 type 이 실린다");
    assert.ok(seen[0]!.stored[0]!.bytes > 0, "계량용 bytes 가 실린다");
    assert.ok(seen[0]!.bytes > 0, "beforeWrite 가 보는 요청 bytes 도 이벤트에 있다");
  } finally { await s.cleanup(); }
});

test("hooks: afterWrite 가 던져도 프로토콜 응답은 성공이다 — 훅은 best-effort 계약", async () => {
  const s = await server({
    hooks: { afterWrite: () => { throw new Error("webhook down"); } },
  });
  try {
    const ok = await fetch(`${s.base}/objects`, {
      method: "POST", headers: { "content-type": "application/json" }, body: OBJ,
    });
    assert.equal(ok.status, 200, "훅 실패는 제품의 문제지 프로토콜 응답의 문제가 아니다");
  } finally { await s.cleanup(); }
});

// ── 판정 평면 탈착 ───────────────────────────────────────────────────────────

test("judgeFor=null: /integrate·/finalize 는 404 로 폴백하고 능력 광고가 정직해진다", async () => {
  const s = await server({ judgeFor: async () => null });
  try {
    const caps = await (await fetch(`${s.base}/version`)).json() as { integrate: boolean };
    assert.equal(caps.integrate, false, "판정 평면이 없으면 광고도 false");
    const res = await fetch(`${s.base}/integrate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: "main", checkpoint: "checkpoint_" + "0".repeat(32), by: "human:t" }),
    });
    assert.equal(res.status, 404, "없는 평면의 404 는 프로토콜의 '폴백' 이다(§0)");
  } finally { await s.cleanup(); }
});

// ── redaction 거부 (v0.3 신규 — 저장만 하고 적용 안 하는 것은 거짓 전파다) ──

test("redaction push 는 403 — 적용 없이 저장하면 클라이언트가 축출이 전파됐다고 믿는다", async () => {
  const s = await server({});
  try {
    const res = await fetch(`${s.base}/objects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "redaction", target: "blob_" + "0".repeat(32) }),
    });
    assert.equal(res.status, 403);
  } finally { await s.cleanup(); }
});
