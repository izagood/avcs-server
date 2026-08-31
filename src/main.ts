#!/usr/bin/env node
// avcs-server 실행 진입점. 설정은 env 로: AVCS_SERVER_DATA(필수 아님, 기본 ./data), PORT.
import { startAvcsServer } from "./server.ts";

const dataDir = process.env.AVCS_SERVER_DATA ?? "./data";
const port = Number(process.env.PORT ?? "8420");

const s = await startAvcsServer({ dataDir, port, host: process.env.HOST ?? "0.0.0.0" });
console.log(`avcs-server listening at ${s.url}  (data: ${dataDir})`);
console.log(`repos live at ${s.url}/<org>/<repo> — e.g. avcs remote add origin ${s.url}/acme/web`);
