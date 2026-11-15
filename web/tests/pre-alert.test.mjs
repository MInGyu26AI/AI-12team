// 승인 전 미리 알림: 승인함 카드 표시(candidate-card) · 배지 정리(shared/labels.ts statusBadges)
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "./load-ts.mjs";

const { statusBadges } = load("@shared/labels");
const { CandidateCard } = load("@/components/review/candidate-card");

const preAlert = { key: "k1", topicKey: "확장 지원", decisions: [{ id: "t1", topic_key: "확장 지원", content: "확장 지원 = 크롬 우선" }] };
const card = (extra = {}) => ({
  id: "c1",
  status: "candidate",
  relevance: "related",
  tag: "decision",
  sentence: "확장은 파이어폭스 먼저 지원하자.",
  subtopic: "작업·결과물",
  topic_key: "확장 지원",
  is_new_topic: false,
  content: "확장 지원 = 파이어폭스 우선",
  reason: null,
  owner: "김동균",
  due: null,
  is_change: true,
  source: "ChatGPT, 2026-11-14 21:10",
  masked: false,
  confidence: 0.9,
  ...extra,
});
const labels = (c) => statusBadges(c).map((b) => b.label);
const render = (c) =>
  renderToStaticMarkup(createElement(CandidateCard, { card: c, checked: true, onCheckedChange() {}, onContentChange() {}, onDismiss() {} }));

test("팀 결정과 어긋나는 후보는 '팀 결정과 어긋남' 배지만 달고 '변경 표현'은 달지 않는다", () => {
  assert.deepEqual(labels(card({ preAlert })), ["팀 결정과 어긋남"]);
  assert.deepEqual(labels(card({ preAlert: null })), ["변경 표현"]); // AI 의 is_change 만 있을 때
  assert.deepEqual(labels(card({ preAlert: null, is_change: false })), []);
  assert.deepEqual(labels(card({ preAlert: null, tag: "todo" })), []);
});

test("승인함 카드에 어긋나는 팀 결정과 '나에게만 보임' 안내를 보인다", () => {
  const html = render(card({ preAlert }));
  assert.match(html, /이 후보는 팀 결정 &#x27;확장 지원 = 크롬 우선&#x27;과 어긋나요\(미리 알림\)/);
  assert.match(html, /나에게만 보이고, 최종 판정은 승인 뒤 팀 서버가 해요/);
  assert.match(html, /title="승인 전 미리 알림이에요/); // 배지에 마우스를 올리면 보이는 설명
});

test("미리 알림이 없는 카드에는 안내 줄이 없다", () => {
  assert.doesNotMatch(render(card({ preAlert: null })), /미리 알림/);
});
