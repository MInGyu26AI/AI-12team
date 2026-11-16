// 확장 경유 RPC(src/lib/rpc.ts)의 기다리는 시간: 수집을 끄는 요청만 확장의 마지막 답변 저장 확인(탭당 최대 65초,
// extension/lib/collection-boundary.ts) + 수집기 호출을 지나서까지 기다리고, 나머지는 25초에 연결 오류로 끝난다.
// 시험 방식은 rpc.test.mjs 와 같다: window·location 을 흉내 내고 시간은 node:test 의 가짜 타이머로 넘긴다.
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const listeners = new Set();
const posted = [];
globalThis.location = { origin: "http://localhost:3000" };
globalThis.window = {
  addEventListener: (_type, fn) => listeners.add(fn),
  removeEventListener: (_type, fn) => listeners.delete(fn),
  postMessage: (data) => posted.push(data),
};
const { BRIDGE_FROM_EXT } = load("@shared/bridge");
const { rpc } = load("@/lib/rpc");

const fromExtension = (data) => [...listeners].forEach((fn) => fn({ source: window, origin: location.origin, data: { source: BRIDGE_FROM_EXT, ...data } }));
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 요청을 보내고 확장이 받았다는 신호까지 준 뒤, 끝났는지(pending)와 결과를 돌려주는 상태 객체
function request(method, params) {
  const state = { done: false, error: null, result: undefined };
  const answer = rpc(method, params).then(
    (result) => { state.done = true; state.result = result; },
    (error) => { state.done = true; state.error = error; },
  );
  const { id } = posted.at(-1);
  fromExtension({ type: "rpc-ack", id });
  return { state, answer, id };
}

test("수집을 끄는 요청은 25초가 지나도 연결 오류로 끝나지 않고 90초까지 기다린다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, answer } = request("collection.configure", { autoCollect: false });
  t.mock.timers.tick(25000);
  t.mock.timers.tick(64000); // 확장이 탭 하나를 65초 가까이 기다리는 동안
  await settle();
  assert.equal(state.done, false);
  t.mock.timers.tick(1000);
  await answer;
  assert.match(state.error.message, /로컬 수집기/); // 90초를 넘기면 그때 연결 오류
  assert.equal(listeners.size, 0);
});

test("수집을 끄는 요청이 65초 뒤에 성공으로 끝나면 그 결과를 받는다 (거짓 연결 오류 없음)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, answer, id } = request("collection.configure", { autoCollect: false });
  t.mock.timers.tick(70000);
  await settle();
  assert.equal(state.done, false);
  fromExtension({ type: "rpc-result", id, ok: true, result: { autoCollect: false } });
  await answer;
  assert.equal(state.error, null);
  assert.deepEqual(state.result, { autoCollect: false });
});

test("수집을 켜는 요청과 다른 설정 변경은 25초에 끝난다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const params of [{ autoCollect: true }, { projectTopic: "주제" }, {}]) {
    const { state, answer } = request("collection.configure", params);
    t.mock.timers.tick(24999);
    await settle();
    assert.equal(state.done, false, JSON.stringify(params));
    t.mock.timers.tick(1);
    await answer;
    assert.match(state.error.message, /로컬 수집기/, JSON.stringify(params));
  }
});

test("다른 요청은 autoCollect:false 를 담아도 25초에 끝난다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, answer } = request("collection.status", { autoCollect: false });
  t.mock.timers.tick(25000);
  await answer;
  assert.match(state.error.message, /로컬 수집기/);
});

test("부른 쪽이 대기 시간을 정하면 그대로 따른다 (싱크 맞추기와 같은 방식)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = { done: false, error: null };
  const answer = rpc("collection.configure", { autoCollect: false }, 1000).catch((error) => { state.error = error; });
  fromExtension({ type: "rpc-ack", id: posted.at(-1).id });
  t.mock.timers.tick(1000);
  await answer;
  assert.match(state.error.message, /로컬 수집기/);
});
