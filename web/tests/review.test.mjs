// 승인함 회귀 시험: 후보 모으기·체크 계산(src/lib/review-candidates.ts)과 승인 요청(src/lib/api/real.ts)
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { mergeCandidates, selectionOf } = load("@/lib/review-candidates");

const card = (id, extra = {}) => ({
  id,
  status: "candidate",
  relevance: "related",
  tag: "decision",
  sentence: `${id} 문장`,
  subtopic: "작업·결과물",
  topic_key: "MVP 범위",
  is_new_topic: false,
  content: `${id} 내용`,
  reason: null,
  owner: null,
  due: null,
  is_change: false,
  source: "ChatGPT, 2026-11-06 21:10",
  masked: false,
  confidence: 0.9,
  ...extra,
});
const guessed = (id) => card(id, { evidence: { messageId: "m1", role: "user", roleGuessed: true, quote: "q" } });
const ids = (cards) => cards.map((c) => c.id);

test("화자 추정 카드가 섞여 있어도 '전체 해제'가 고를 수 있는 카드를 모두 끈다", () => {
  const cards = [card("a"), card("b"), guessed("g")];
  const start = selectionOf(cards, {});
  assert.deepEqual(ids(start.selected), ["a", "b"]);
  assert.equal(start.allSelected, true); // 고치기 전에는 화자 추정 카드 때문에 늘 false 라 '전체 선택'만 보였다

  const cleared = selectionOf(cards, start.toggledAll);
  assert.deepEqual(ids(cleared.selected), []);
  assert.equal(cleared.allSelected, false);

  const again = selectionOf(cards, cleared.toggledAll);
  assert.deepEqual(ids(again.selected), ["a", "b"]);
});

test("확신도가 낮은 카드는 기본으로 빠지고 '전체 선택'이 켠다", () => {
  const cards = [card("a"), card("low", { confidence: 0.5 })];
  const start = selectionOf(cards, {});
  assert.deepEqual(ids(start.selected), ["a"]);
  assert.equal(start.allSelected, false);
  assert.deepEqual(ids(selectionOf(cards, start.toggledAll).selected), ["a", "low"]);
});

test("고를 수 있는 카드가 없으면 전체 선택으로 보지 않는다", () => {
  const only = selectionOf([guessed("g")], { g: true });
  assert.deepEqual(only.selectable, []);
  assert.deepEqual(only.selected, []);
  assert.equal(only.allSelected, false);
});

test("실제 모드(붙여넣기 후보를 넘기지 않음)는 브라우저에 남은 목업 개인 수를 세지 않는다", () => {
  const merged = mergeCandidates([card("x")], null, null);
  assert.equal(merged.personal, 0);
  assert.deepEqual(ids(merged.shareable), ["x"]);
});

test("목업 모드는 붙여넣기 후보와 개인 내용 수를 함께 보여 준다", () => {
  const merged = mergeCandidates([], { cards: [card("p", { tag: "todo" })], personal: 2, label: "붙여넣은 대화" }, null);
  assert.equal(merged.personal, 2);
  assert.equal(merged.total, 1);
  assert.deepEqual(ids(merged.shareable), ["p"]);
});

test("수집기 후보의 새 주제 여부는 팀 보드 기준으로 다시 정하고, 결정·조사·할 일 순으로 나눈다", () => {
  const merged = mergeCandidates(
    [card("t", { tag: "todo" }), card("d", { topic_key: "새 주제" }), card("n", { tag: "none" }), card("q", { deliveryState: "pending" })],
    null,
    new Set(["MVP 범위"]),
  );
  assert.deepEqual(ids(merged.shareable), ["d", "t"]);
  assert.equal(merged.shareable[0].is_new_topic, true);
  assert.equal(merged.shareable[1].is_new_topic, false);
  assert.deepEqual(ids(merged.others), ["n"]);
  assert.deepEqual(ids(merged.queued), ["q"]);
});

test("실제 승인은 화면에 보인 팀으로 candidates.approve 한 번만 보낸다", async () => {
  const calls = [];
  const realFetch = global.fetch;
  const bridge = process.env.NEXT_PUBLIC_LOCAL_BRIDGE;
  process.env.NEXT_PUBLIC_LOCAL_BRIDGE = "true"; // rpc.ts 가 /api/local 로 보내게 해서 fetch 로 가로챈다
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ ok: true, result: { items: [] } }) };
  };
  try {
    const { createRealApi } = load("@/lib/api/real");
    const result = await createRealApi().approveItems([card("a"), card("b")], "team-shown");
    assert.deepEqual(result, { conflicts: [] });
    // 예전에는 승인 직전에 collection.status 로 팀을 새로 읽어, 그사이 팀이 바뀌어도 수집기의 팀 변경 검사를 통과했다
    assert.deepEqual(
      calls.map((c) => [c.url, c.body.method, c.body.params]),
      [["/api/local", "candidates.approve", { ids: ["a", "b"], teamId: "team-shown" }]],
    );
  } finally {
    global.fetch = realFetch;
    if (bridge === undefined) delete process.env.NEXT_PUBLIC_LOCAL_BRIDGE;
    else process.env.NEXT_PUBLIC_LOCAL_BRIDGE = bridge;
  }
});
