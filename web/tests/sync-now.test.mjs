// 싱크 맞추기(docs/sync-contract.md 5장 syncNow) 웹 쪽 시험: src/lib/rpc.ts 의 syncNow·syncNowSummary,
// src/lib/local-collector.ts 의 syncAndRefresh, src/lib/use-review.ts 의 useSyncOnOpen(승인함 자동 맞추기).
// 확장은 가짜다: 웹이 window.postMessage 로 보낸 요청에 rpc-ack·rpc-result 로 답한다 (실제는 extension/entrypoints/web-bridge.content.ts).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { load } from "./load-ts.mjs";

const listeners = new Set();
const sent = []; // 웹이 확장에 보낸 요청 { method, params }
let extension = null; // (method, params) => 결과 | Promise. null 이면 확장이 없다 (신호도 답도 없음)
globalThis.location = { origin: "http://localhost:3000" };
globalThis.window = {
  addEventListener: (_type, fn) => listeners.add(fn),
  removeEventListener: (_type, fn) => listeners.delete(fn),
  postMessage: (data) => {
    sent.push({ method: data.method, params: data.params });
    if (!extension) return;
    setImmediate(async () => {
      deliver({ type: "rpc-ack", id: data.id });
      try {
        deliver({ type: "rpc-result", id: data.id, ok: true, result: await extension(data.method, data.params) });
      } catch (error) {
        deliver({ type: "rpc-result", id: data.id, ok: false, error: error.message });
      }
    });
  },
};

const { BRIDGE_FROM_EXT, EXT_SYNC_NOW } = load("@shared/bridge");
const { ExtensionMissing, SyncStillRunning, rpc, syncNow, syncNowErrorNotice, syncNowSummary } = load("@/lib/rpc");
const { canSyncNow, syncAndRefresh, watchCollector } = load("@/lib/local-collector");
const { useSyncOnOpen } = load("@/lib/use-review");
const React = createRequire(import.meta.url)("react");

const deliver = (data) =>
  [...listeners].forEach((fn) => fn({ source: window, origin: location.origin, data: { source: BRIDGE_FROM_EXT, ...data } }));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => {
  for (let i = 0; i < 6; i += 1) await settle();
};
const methodsSent = () => sent.map((s) => s.method);
const countOf = (method) => methodsSent().filter((m) => m === method).length;

const RAN = { sync: "ran", newTurns: 3, flushed: true };
const status = (extra = {}) => ({
  teamId: "team-a",
  teamName: "A팀",
  userName: "나",
  recent: [],
  turnsPerBatch: 10,
  bufferedTurns: 0,
  autoCollect: true,
  endsAt: new Date(Date.now() + 3600_000).toISOString(),
  ...extra,
});
// 가짜 확장 + 수집기: 싱크 맞추기와 승인함이 읽는 요청에 답한다. outcome 이 Error 면 싱크 맞추기가 실패한다
function installExtension(outcome = RAN) {
  sent.length = 0;
  extension = async (method) => {
    if (method === EXT_SYNC_NOW) {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    if (method === "candidates.list") return { cards: [], status: status() };
    if (method === "privacy.list") return { teamId: "team-a", items: [], excluded: [], excludedCount: 0 };
    if (method === "collection.status") return status();
    throw new Error(`예상하지 못한 요청 ${method}`);
  };
}

// NEXT_PUBLIC_LOCAL_BRIDGE=true: 확장이 없고 웹 서버의 /api/local 로 수집기를 부른다
async function viaLocalBridge(collectionStatus, run) {
  const methods = [];
  const savedFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_LOCAL_BRIDGE = "true";
  globalThis.fetch = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    methods.push(method);
    return { ok: true, json: async () => ({ ok: true, result: method === "collection.status" ? collectionStatus : {} }) };
  };
  try {
    return { result: await run(), methods };
  } finally {
    delete process.env.NEXT_PUBLIC_LOCAL_BRIDGE;
    globalThis.fetch = savedFetch;
  }
}

test("확장 경유: ext.syncNow 를 reason 과 함께 보내고 확장이 준 결과를 그대로 돌려준다", async () => {
  installExtension({ sync: "no-tab", newTurns: 0, flushed: false, blockedReason: "수집이 꺼져 있어요" });
  assert.deepEqual(await syncNow("button"), { sync: "no-tab", newTurns: 0, flushed: false, blockedReason: "수집이 꺼져 있어요" });
  assert.deepEqual(sent, [{ method: EXT_SYNC_NOW, params: { reason: "button" } }]);

  await syncNow("review-open");
  assert.deepEqual(sent.at(-1), { method: EXT_SYNC_NOW, params: { reason: "review-open" } });
});

test("확장이 오류로 답하면 던진다", async () => {
  installExtension(new Error("수집기를 새 버전으로 바꾸면 쓸 수 있어요"));
  await assert.rejects(syncNow("button"), /새 버전/);
});

test("확장이 없으면 ExtensionMissing 으로 끝난다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  extension = null;
  const answer = syncNow("review-open");
  t.mock.timers.tick(2000);
  await assert.rejects(answer, (error) => error instanceof ExtensionMissing);
});

test("싱크 맞추기는 일반 요청의 25초를 넘어서도 기다린다 (패스가 대화를 20건 받는 동안)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  extension = () => new Promise((resolve) => (release = resolve)); // 확장이 패스를 도는 중
  const answer = syncNow("button");
  await settle(); // 확장이 받았다는 신호 도착
  t.mock.timers.tick(149999);
  await settle();
  release(RAN);
  assert.deepEqual(await answer, RAN);
});

test("150초를 넘기면 연결 오류가 아니라 '아직 진행 중' 안내가 된다. 일반 요청의 시간 초과는 그대로 연결 오류다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  extension = () => new Promise(() => {}); // 확장은 받았지만 패스가 아직 끝나지 않음
  let done = false;
  const slow = syncNow("button");
  const ended = assert.rejects(slow, (error) => error instanceof SyncStillRunning && !(error instanceof ExtensionMissing));
  slow.then(() => (done = true), () => (done = true));
  await settle();
  t.mock.timers.tick(149999);
  await settle();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await ended;

  const notice = syncNowErrorNotice(await slow.catch((error) => error));
  assert.deepEqual(notice, { tone: "info", text: "동기화가 아직 진행 중이에요. 잠시 뒤 다시 확인해 주세요" });
  assert.deepEqual(syncNowErrorNotice(new Error("연결 실패")), { tone: "error", text: "연결 실패" });

  const plain = rpc("collection.status"); // 싱크 맞추기가 아닌 요청은 25초에 연결 오류
  await settle();
  t.mock.timers.tick(25000);
  await assert.rejects(plain, (error) => !(error instanceof SyncStillRunning) && !(error instanceof ExtensionMissing) && /로컬 수집기/.test(error.message));
});

test("LOCAL_BRIDGE: 수집 중이면 collection.flush 만 부르고 sync 는 off 다", async () => {
  const { result, methods } = await viaLocalBridge(status(), () => syncNow("button"));
  assert.deepEqual(result, { sync: "off", newTurns: 0, flushed: true });
  assert.deepEqual(methods, ["collection.status", "collection.flush"]);
});

test("LOCAL_BRIDGE: 일시정지·종료 뒤에는 flush 하지 않고 이유를 돌려준다", async () => {
  const paused = await viaLocalBridge(status({ autoCollect: false }), () => syncNow("review-open"));
  assert.deepEqual(paused.methods, ["collection.status"]);
  assert.equal(paused.result.sync, "off");
  assert.equal(paused.result.flushed, false);
  assert.match(paused.result.blockedReason, /수집이 꺼져 있어요/);

  const ended = await viaLocalBridge(status({ endsAt: new Date(Date.now() - 1000).toISOString() }), () => syncNow("review-open"));
  assert.deepEqual(ended.methods, ["collection.status"]);
  assert.equal(ended.result.flushed, false);
  assert.match(ended.result.blockedReason, /종료 시각이 지났어요/);
});

test("결과 안내: sync 값마다 짧은 문구와 토스트 종류, 새 대화 수, 분류 여부", () => {
  const summary = (result) => syncNowSummary({ newTurns: 0, flushed: false, ...result });
  assert.deepEqual(summary({ sync: "ran", newTurns: 3, flushed: true }), { tone: "success", text: "새 대화 3개를 가져왔어요. 쌓인 대화는 분류에 보냈어요" });
  assert.deepEqual(summary({ sync: "ran", flushed: true }), { tone: "success", text: "새로 가져올 대화가 없어요. 쌓인 대화는 분류에 보냈어요" });
  assert.deepEqual(summary({ sync: "off", flushed: true }), { tone: "success", text: "프로젝트 동기화는 꺼져 있어요. 쌓인 대화는 분류에 보냈어요" });
  assert.deepEqual(summary({ sync: "resting" }), { tone: "warning", text: "ChatGPT 요청을 잠시 쉬는 중이에요" });
  assert.deepEqual(summary({ sync: "no-tab" }), { tone: "warning", text: "chatgpt.com 탭을 하나 열어 두세요" });
  assert.deepEqual(summary({ sync: "busy" }), { tone: "info", text: "이미 맞추는 중이에요" });
  assert.equal(summary({ sync: "failed" }).tone, "error");
  assert.match(summary({ sync: "failed" }).text, /싱크를 맞추지 못했어요/);
});

test("결과 안내: 분류를 못 보낸 이유가 있으면 덧붙이고, 성공이어도 주의로 바꾼다. 모르는 sync 값은 실패로 본다", () => {
  const blocked = syncNowSummary({ sync: "ran", newTurns: 2, flushed: false, blockedReason: "수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요" });
  assert.deepEqual(blocked, { tone: "warning", text: "새 대화 2개를 가져왔어요. 수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요" });
  assert.equal(syncNowSummary({ sync: "ran", newTurns: 0, flushed: false }).text, "새로 가져올 대화가 없어요"); // 이유가 없으면 덧붙이지 않는다
  assert.equal(syncNowSummary({ sync: "from-the-future", newTurns: 0, flushed: false }).tone, "error");
});

test("싱크 맞추기 버튼: 수집 중일 때만 누를 수 있고, 프로젝트 동기화가 켜져 있으면 쌓인 대화가 0이어도 누를 수 있다", () => {
  const sync = { enabled: true, account: "a".repeat(64), since: "2026-11-13T00:00:00.000Z" };
  assert.equal(canSyncNow(status({ bufferedTurns: 0 })), false); // 쌓인 것도 동기화도 없음
  assert.equal(canSyncNow(status({ bufferedTurns: 2 })), true);
  assert.equal(canSyncNow(status({ bufferedTurns: 0, accountSync: sync })), true);
  assert.equal(canSyncNow(status({ bufferedTurns: 0, accountSync: { ...sync, enabled: false, since: null } })), false);
  assert.equal(canSyncNow(status({ bufferedTurns: 0, accountSync: null })), false); // 한 번도 켠 적 없음
  assert.equal(canSyncNow(status({ bufferedTurns: 5, accountSync: sync, autoCollect: false })), false); // 일시정지가 먼저
});

test("syncAndRefresh: 끝나면 보여 줄 화면이 있을 때 후보를 다시 읽는다", async () => {
  installExtension();
  const stop = watchCollector(() => {}, "candidates");
  await idle();
  sent.length = 0;

  assert.deepEqual(await syncAndRefresh("review-open"), RAN);
  assert.deepEqual(methodsSent(), [EXT_SYNC_NOW, "candidates.list", "privacy.list"]);
  stop();

  sent.length = 0;
  await syncAndRefresh("button"); // 화면이 없으면 다시 읽지 않는다
  assert.deepEqual(methodsSent(), [EXT_SYNC_NOW]);
});

test("syncAndRefresh: 돌고 있는 동안 다시 불러도 한 번만 보내고, 끝나면 다시 보낼 수 있다", async () => {
  installExtension();
  const first = syncAndRefresh("review-open");
  const second = syncAndRefresh("review-open"); // StrictMode 의 두 번째 실행, 또는 같은 때 누른 버튼
  assert.equal(first, second);
  await first;
  assert.equal(countOf(EXT_SYNC_NOW), 1);

  await syncAndRefresh("button");
  assert.equal(countOf(EXT_SYNC_NOW), 2);
});

test("syncAndRefresh: 실패는 던지고 후보를 다시 읽지 않으며, 다음 호출은 다시 보낸다", async () => {
  installExtension(new Error("연결 실패"));
  const stop = watchCollector(() => {}, "candidates");
  await idle();
  sent.length = 0;

  await assert.rejects(syncAndRefresh("button"), /연결 실패/);
  assert.deepEqual(methodsSent(), [EXT_SYNC_NOW]);
  await assert.rejects(syncAndRefresh("button"), /연결 실패/);
  assert.equal(countOf(EXT_SYNC_NOW), 2);
  stop();
});

// 승인함: 컴포넌트 없이 훅만 돌린다. useRef·useEffect 를 가짜로 바꿔, 같은 ref 로 효과를 두 번 돌리는 StrictMode 를 흉내 낸다
function renderHook(ref) {
  const real = { useRef: React.useRef, useEffect: React.useEffect };
  let effect;
  React.useRef = () => ref;
  React.useEffect = (fn) => (effect = fn);
  try {
    useSyncOnOpen();
  } finally {
    Object.assign(React, real);
  }
  return effect;
}

test("승인함을 열면 싱크 맞추기를 한 번 부른다 (StrictMode 의 이중 효과에도 한 번)", async () => {
  installExtension();
  const effect = renderHook({ current: false });
  effect(); // 처음 실행
  effect(); // StrictMode 가 같은 ref 로 한 번 더 실행
  await idle();
  assert.deepEqual(sent, [{ method: EXT_SYNC_NOW, params: { reason: "review-open" } }]);

  renderHook({ current: false })(); // 승인함을 다시 열면 새 진입이다
  await idle();
  assert.equal(countOf(EXT_SYNC_NOW), 2);
});

test("승인함 자동 맞추기는 실패하거나 확장이 없어도 조용히 넘어간다", async (t) => {
  installExtension(new Error("수집기 오류"));
  renderHook({ current: false })();
  await idle(); // 처리하지 않은 거절이 있으면 node:test 가 실패로 센다
  assert.equal(countOf(EXT_SYNC_NOW), 1);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  extension = null; // 확장 없음: 안내 대화상자는 주기 읽기가 띄운다
  renderHook({ current: false })();
  t.mock.timers.tick(2000);
  await idle();

  extension = () => new Promise(() => {}); // 150초를 넘겨도 승인함은 아무것도 띄우지 않는다
  renderHook({ current: false })();
  await idle();
  t.mock.timers.tick(150000);
  await idle();
});
