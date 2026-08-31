#!/usr/bin/env node
// avcs-server 실행 진입점. 설정은 env 로: AVCS_SERVER_DATA(필수 아님, 기본 ./data), PORT.
import { startAvcsServer } from "./server.ts";

const dataDir = process.env.AVCS_SERVER_DATA ?? "./data";
const port = Number(process.env.PORT ?? "8420");
// AVCS_SERVER_GATED=1 이면 쓰기가 멤버 서명(AVCS-Sig)을 요구한다. 멤버 디렉터리는 코어
// 네이티브(member:<keyId> ref → Membership) — 커스텀 디렉터리·토큰·훅은 라이브러리로
// import 해 조립하는 쪽의 몫이다.
const gated = process.env.AVCS_SERVER_GATED === "1" || process.env.AVCS_SERVER_GATED === "true";

const s = await startAvcsServer({ dataDir, port, host: process.env.HOST ?? "0.0.0.0", gated });
console.log(`avcs-server listening at ${s.url}  (data: ${dataDir})`);
console.log(`repos live at ${s.url}/<org>/<repo> — e.g. avcs remote add origin ${s.url}/acme/web`);
