// 확장 경유 RPC(src/lib/rpc.ts): 확장이 받았다는 신호(rpc-ack)를 2초 안에 보내지 않으면 확장이 없다고 본다.
// 브라우저 대신 window·location 을 흉내 내고, 시간은 node:test 의 가짜 타이머로 넘긴다.
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
const { rpc, ExtensionMissing } = load("@/lib/rpc");

// 확장(web-bridge)이 같은 창·같은 출처에서 보낸 것처럼 전달한다
const fromExtension = (data) => [...listeners].forEach((fn) => fn({ source: window, origin: location.origin, data: { source: BRIDGE_FROM_EXT, ...data } }));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("확장이 2초 안에 받았다는 신호를 보내지 않으면 ExtensionMissing 으로 끝난다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = rpc("collection.status");
  t.mock.timers.tick(1999);
  await settle();
  t.mock.timers.tick(1);
  await assert.rejects(answer, (error) => error instanceof ExtensionMissing);
  assert.equal(listeners.size, 0); // 기다리던 리스너를 거둔다
});

test("신호를 받으면 2초가 지나도 수집기 응답을 기다린다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = rpc("collection.status");
  const { id } = posted.at(-1);
  fromExtension({ type: "rpc-ack", id });
  t.mock.timers.tick(10000);
  fromExtension({ type: "rpc-result", id, ok: true, result: { teamId: "a" } });
  assert.deepEqual(await answer, { teamId: "a" });
});

test("신호 뒤 25초까지 응답이 없으면 연결 오류로 끝난다 (확장 없음과 구분)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = rpc("collection.status");
  fromExtension({ type: "rpc-ack", id: posted.at(-1).id });
  t.mock.timers.tick(25000);
  await assert.rejects(answer, (error) => !(error instanceof ExtensionMissing) && /로컬 수집기/.test(error.message));
});

test("다른 요청 id 의 신호는 이 요청을 살리지 않는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answer = rpc("collection.status");
  fromExtension({ type: "rpc-ack", id: "someone-else" });
  t.mock.timers.tick(2000);
  await assert.rejects(answer, (error) => error instanceof ExtensionMissing);
});
