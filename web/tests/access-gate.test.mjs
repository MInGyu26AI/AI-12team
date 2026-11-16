// 로그인·PC 연결 확인 문(src/components/app-access-gate.tsx)의 판정: checkAccess(한 번 확인한 결과)와 nextView(결과에 따른 다음 화면).
// 이미 열린(ready) 화면은 429·5xx·네트워크 끊김 같은 일시 실패로 막지 않고, 401·403·계정 불일치·확장 없음은 지금처럼 막는다.
// fetch 와 확장은 가짜다: 확장은 window.postMessage 로 받은 요청에 rpc-ack·rpc-result 로 답한다 (실제는 extension/entrypoints/web-bridge.content.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const listeners = new Set();
let collectorStatus = null; // 확장이 collection.status 에 돌려줄 값. null 이면 확장이 없다 (신호도 답도 없음)
globalThis.location = { origin: "http://localhost:3000" };
globalThis.window = {
  addEventListener: (_type, fn) => listeners.add(fn),
  removeEventListener: (_type, fn) => listeners.delete(fn),
  postMessage: (data) => {
    if (!collectorStatus) return;
    setImmediate(() => {
      deliver({ type: "rpc-ack", id: data.id });
      deliver({ type: "rpc-result", id: data.id, ok: true, result: collectorStatus });
    });
  },
};
const { BRIDGE_FROM_EXT } = load("@shared/bridge");
const { checkAccess, nextView, isTransientStatus } = load("@/components/app-access-gate");
const deliver = (data) => [...listeners].forEach((fn) => fn({ source: window, origin: location.origin, data: { source: BRIDGE_FROM_EXT, ...data } }));
const settle = () => new Promise((resolve) => setImmediate(resolve));

const alice = { id: "11111111-1111-4111-8111-111111111111", name: "동명 사용자", teams: [{ id: "team-a", name: "팀 A" }] };
const bob = { ...alice, id: "22222222-2222-4222-8222-222222222222", name: "다른 사용자" };
const signal = new AbortController().signal;

// 다음 /api/onboarding 호출의 응답 (Error 면 네트워크 오류)
let onboarding;
globalThis.fetch = async () => {
  if (onboarding instanceof Error) throw onboarding;
  return { status: onboarding.status, ok: onboarding.status >= 200 && onboarding.status < 300, json: async () => onboarding.body };
};
const reply = (status, body) => { onboarding = { status, body }; };
const ready = (account = alice) => ({ kind: "ready", account });

test("일시 실패로 보는 것은 429 와 5xx 뿐이다", () => {
  for (const status of [429, 500, 502, 503, 504]) assert.equal(isTransientStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 409, 200]) assert.equal(isTransientStatus(status), false, String(status));
});

test("401 은 로그인으로 보낸다", async () => {
  reply(401, { error: "GitHub로 로그인해 주세요." });
  assert.deepEqual(await checkAccess(signal), { kind: "login" });
});

test("429 는 일시 실패이고, 첫 확인이면 잠시 기다렸다가 다시 확인하라고 알린다", async () => {
  reply(429, { error: "rate limited" });
  const result = await checkAccess(signal);
  assert.equal(result.kind, "failed");
  assert.equal(result.transient, true);
  assert.match(result.message, /잠깐 기다렸다가/);
  assert.match(result.message, /다시 확인/);
});

test("5xx 와 네트워크 오류도 일시 실패다", async () => {
  for (const status of [500, 502, 503]) {
    reply(status, { error: "upstream" });
    const result = await checkAccess(signal);
    assert.deepEqual([result.kind, result.transient], ["failed", true], String(status));
    assert.match(result.message, /로그인 상태를 확인하지 못했어요/);
  }
  onboarding = new TypeError("fetch failed");
  const result = await checkAccess(signal);
  assert.deepEqual([result.kind, result.transient], ["failed", true]);
});

test("403·404 같은 거절은 지금처럼 막는 실패다", async () => {
  for (const status of [400, 403, 404]) {
    reply(status, { error: "denied" });
    const result = await checkAccess(signal);
    assert.deepEqual([result.kind, result.transient], ["failed", false], String(status));
    assert.match(result.message, /로그인 상태를 확인하지 못했어요/);
  }
});

test("로그인과 PC 연결이 맞으면 ready", async () => {
  reply(200, alice);
  collectorStatus = { userId: alice.id, teamId: "team-a" };
  assert.deepEqual(await checkAccess(signal), ready());
});

test("PC 에 연결된 계정이 다르거나 팀이 없으면 막는 실패다 (일시 실패가 아니다)", async () => {
  reply(200, alice);
  collectorStatus = { userId: bob.id, teamId: "team-a" };
  let result = await checkAccess(signal);
  assert.deepEqual([result.kind, result.transient, result.account], ["failed", false, alice]);
  assert.match(result.message, /계정이 달라/);
  collectorStatus = { userId: alice.id, teamId: "team-z" };
  result = await checkAccess(signal);
  assert.deepEqual([result.kind, result.transient], ["failed", false]);
  assert.match(result.message, /참여한 팀/);
});

test("가입 정보가 깨졌으면 막는 실패다", async () => {
  reply(200, { name: "이름만" });
  const result = await checkAccess(signal);
  assert.deepEqual([result.kind, result.transient], ["failed", false]);
});

test("확장이 없으면 막는 실패다 (일시 실패가 아니다)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reply(200, alice);
  collectorStatus = null;
  const answer = checkAccess(signal);
  await settle();
  t.mock.timers.tick(2000);
  const result = await answer;
  assert.deepEqual([result.kind, result.transient, result.account], ["failed", false, alice]);
  assert.match(result.message, /이 PC에 SyncUp을 연결/);
});

test("열려 있던 화면은 일시 실패로 닫지 않는다 (같은 화면 그대로)", () => {
  const open = ready();
  assert.equal(nextView(open, { kind: "failed", transient: true, message: "429" }), open);
});

test("첫 확인(checking)이나 막힌 화면에서의 일시 실패는 막는 화면이다", () => {
  assert.deepEqual(nextView({ kind: "checking" }, { kind: "failed", transient: true, message: "잠시 뒤" }), { kind: "blocked", message: "잠시 뒤", account: undefined });
  assert.deepEqual(nextView({ kind: "blocked", message: "예전" }, { kind: "failed", transient: true, message: "새 안내" }), { kind: "blocked", message: "새 안내", account: undefined });
});

test("열려 있던 화면도 막는 실패(계정 불일치·확장 없음·403)나 401 에는 막거나 로그인으로 간다", () => {
  assert.deepEqual(nextView(ready(), { kind: "failed", transient: false, message: "계정이 달라요", account: alice }), { kind: "blocked", message: "계정이 달라요", account: alice });
  assert.deepEqual(nextView(ready(), { kind: "login" }), { kind: "checking" });
});

test("확인에 성공하면 막힌 화면도 다시 열린다", () => {
  assert.deepEqual(nextView({ kind: "blocked", message: "x", account: alice }, ready()), ready());
  assert.deepEqual(nextView(ready(alice), ready(bob)), ready(bob));
});
