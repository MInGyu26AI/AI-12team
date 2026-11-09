// 공유 폴러(src/lib/local-collector.ts) 회귀 시험: 무엇을 읽는지, 늦게 온 응답을 버리는지.
// rpc.ts 를 /api/local 경로로 돌리고 fetch 를 가로채 응답 시점을 손으로 정한다.
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

process.env.NEXT_PUBLIC_LOCAL_BRIDGE = "true";
const calls = []; // { method, answer(result), fail(error) }
globalThis.fetch = (url, init) =>
  new Promise((resolve, reject) => {
    const { method } = JSON.parse(init.body);
    calls.push({ method, answer: (result) => resolve({ ok: true, json: async () => ({ ok: true, result }) }), fail: reject });
  });

const { watchCollector, readCollector } = load("@/lib/local-collector");
const { ExtensionMissing } = load("@/lib/rpc");
const { POLL_MS } = load("@/lib/api");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastCall = () => calls.at(-1);
const status = (teamId) => ({ teamId, teamName: teamId, userName: "나", recent: [], turnsPerBatch: 10, bufferedTurns: 0 });
const card = { id: "c1", tag: "decision", relevance: "related", content: "결정", confidence: 0.9 };

test("헤더처럼 상태만 필요하면 collection.status 만, 후보 화면이 열리면 바로 candidates.list 를 읽는다", async () => {
  const stopHeader = watchCollector(() => {}, "status");
  assert.equal(lastCall().method, "collection.status");
  const oldStatus = lastCall();

  const stopReview = watchCollector(() => {}, "candidates");
  assert.equal(lastCall().method, "candidates.list");
  lastCall().answer({ cards: [card], status: status("team-new") });
  await settle();
  assert.equal(lastCall().method, "privacy.list");
  lastCall().answer({ teamId: "team-new", items: [], excluded: [], excludedCount: 0 });

  oldStatus.answer(status("team-old")); // 먼저 보냈지만 늦게 온 응답
  await settle();
  assert.equal(readCollector().status.teamId, "team-new");
  assert.deepEqual(readCollector().cards.map((c) => c.id), ["c1"]);
  assert.equal(readCollector().privacy.teamId, "team-new");

  stopReview();
  stopHeader();
});

test("후보 화면을 떠난 뒤 늦게 온 candidates.list 응답은 비운 후보 목록을 다시 채우지 않는다", async () => {
  const stop = watchCollector(() => {}, "candidates");
  const pending = lastCall();
  assert.equal(pending.method, "candidates.list");
  stop();
  assert.deepEqual(readCollector().cards, []);

  pending.answer({ cards: [card], status: status("team-a") });
  await settle();
  assert.deepEqual(readCollector().cards, []);
  assert.equal(readCollector().cardsChecked, false); // 다시 열면 불러오는 중부터 보인다
});

test("주기 요청은 앞 요청이 끝나기 전에 겹쳐 보내지 않는다 (늦게 끝나는 요청이 버려져 '확인 중'에 머물던 문제)", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stop = watchCollector(() => {}, "status");
  const first = lastCall();
  const before = calls.length;
  t.mock.timers.tick(POLL_MS * 3); // 응답이 오래 걸려도
  assert.equal(calls.length, before); // 새 요청을 보내지 않는다
  first.answer(status("team-a"));
  await settle();
  assert.equal(readCollector().statusChecked, true);
  assert.equal(readCollector().status.teamId, "team-a");
  t.mock.timers.tick(POLL_MS);
  assert.equal(calls.length, before + 1); // 끝난 뒤에는 다시 묻는다
  lastCall().answer(status("team-a"));
  await settle();
  stop();
});

test("확장이 요청을 받지 않으면 확인을 마치고 extensionMissing 으로 알린다", async () => {
  const stop = watchCollector(() => {}, "candidates");
  lastCall().fail(new ExtensionMissing());
  await settle();
  assert.equal(readCollector().extensionMissing, true);
  assert.equal(readCollector().cardsChecked, true); // '확인 중'에 머물지 않는다
  assert.equal(readCollector().available, false);
  stop();
});
