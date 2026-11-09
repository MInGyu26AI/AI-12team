// /api/local(src/app/api/local/route.ts) 실패 응답 회귀 시험: 알려진 실패 이유는 그대로, 너무 큰 요청은 413,
// 그 밖의 오류는 수집기 안내 하나로 묶는다. 세션·출처 검사는 통과시키고 연결 파일만 바꿔 가며 부른다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { load } from "./load-ts.mjs";

const ORIGIN = "http://127.0.0.1:4100";
const UNREACHABLE = "로컬 수집기 실행 상태와 연결 파일을 확인하세요.";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncup-local-route-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

Object.assign(process.env, {
  NEXT_PUBLIC_LOCAL_BRIDGE: "true",
  SYNCUP_LOCAL_SESSION: "session-1",
  SYNCUP_LOCAL_EXPIRES: String(Date.now() + 60_000),
  SYNCUP_LOCAL_ORIGIN: ORIGIN,
});

let fetched = 0;
globalThis.fetch = async () => {
  fetched += 1;
  throw new TypeError("fetch failed"); // 수집기가 꺼진 경우
};

const { POST } = load("@/app/api/local/route");

let files = 0;
/** 연결 파일을 만들고 그 파일로 POST 를 부른다 */
async function post({ url = "http://127.0.0.1:4200/rpc", token = "a".repeat(43), mode = 0o600, body = "{}" } = {}) {
  const file = path.join(dir, `connection-${(files += 1)}.json`);
  fs.writeFileSync(file, JSON.stringify({ url, token }));
  fs.chmodSync(file, mode);
  process.env.SYNCUP_CONNECTION_FILE = file;
  const request = new Request(`${ORIGIN}/api/local`, {
    method: "POST",
    headers: { cookie: "syncup_local=session-1", origin: ORIGIN, host: "127.0.0.1:4100" },
    body,
  });
  const response = await POST(request);
  return { status: response.status, error: (await response.json()).error };
}

test("요청 본문이 4MB 를 넘으면 수집기에 보내지 않고 413 '요청 크기 오류'", async () => {
  const before = fetched;
  assert.deepEqual(await post({ body: "x".repeat(4 * 1024 * 1024 + 1) }), { status: 413, error: "요청 크기 오류" });
  assert.equal(fetched, before);
});

test("연결 파일·주소·인증 오류는 이유를 그대로 503 으로 돌려준다", async () => {
  assert.deepEqual(await post({ mode: 0o644 }), { status: 503, error: "연결 파일 권한 오류" });
  assert.deepEqual(await post({ url: "http://example.com/rpc" }), { status: 503, error: "연결 주소 오류" });
  assert.deepEqual(await post({ token: "short" }), { status: 503, error: "연결 인증 오류" });
});

test("수집기에 닿지 못하는 등 그 밖의 오류는 수집기 안내 하나로 묶는다", async () => {
  const before = fetched;
  assert.deepEqual(await post(), { status: 503, error: UNREACHABLE });
  assert.equal(fetched, before + 1);
});
