// 팀 보드 회전 보기 (src/components/board/decision-carousel.tsx): 원기둥 반지름·앞 카드 계산, 12장 제한, 충돌 패널, 보기 전환 버튼
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "./load-ts.mjs";

const { ringRadius, wrapIndex, ringDistance, ringOpacity, MAX_RING, DecisionCarousel, BoardViewToggle } = load("@/components/board/decision-carousel");

const card = (i, extra = {}) => ({
  id: `d${i}`, relevance: "related", tag: "decision", subtopic: "작업·결과물", topic_key: "MVP 범위", is_new_topic: false,
  content: `결정 ${i}`, reason: null, owner: "김도윤", due: null, is_change: false, source: "ChatGPT, 2026-11-14 20:00",
  masked: false, confidence: 0.9, status: "approved", sentence: `문장 ${i}`, ...extra,
});

test("카드 수에 맞춘 반지름: 8장이면 520px, 많을수록 커지고, 2장 이하는 겹치지 않는 최소값", () => {
  assert.equal(ringRadius(8), 520);
  assert.ok(ringRadius(12) > ringRadius(8));
  assert.ok(ringRadius(4) < ringRadius(8));
  assert.equal(ringRadius(2), 240);
  assert.equal(ringRadius(1), 0);
  assert.equal(ringRadius(0), 0);
});

test("앞 카드 번호는 원을 따라 감기고, 거리는 가까운 쪽으로 잰다", () => {
  assert.equal(wrapIndex(-1, 5), 4); // ← 를 눌러 첫 장 앞으로 가면 마지막 장
  assert.equal(wrapIndex(12, 5), 2);
  assert.equal(wrapIndex(3, 0), 0);
  assert.equal(ringDistance(0, 7, 8), 1); // 0 과 7 은 원 위에서 이웃
  assert.equal(ringDistance(2, 6, 8), 4);
  assert.deepEqual([0, 1, 2, 3, 5].map(ringOpacity), [1, 0.8, 0.45, 0.18, 0.18]);
});

test("원기둥에는 최근 12장까지만, 앞 카드에 충돌이 걸렸으면 '결정이 엇갈렸어요' 패널", () => {
  const decisions = Array.from({ length: 15 }, (_, i) => card(i));
  const flagged = new Map([["d0", { level: "conflict", previous: "실내만" }]]);
  const html = renderToStaticMarkup(createElement(DecisionCarousel, { decisions, flagged, onOpenConflict: () => {} }));
  assert.equal(MAX_RING, 12);
  assert.equal((html.match(/<article/g) ?? []).length, 12);
  assert.match(html, /결정이 엇갈렸어요 · 이전: 실내만/);
  assert.match(html, /01 \/ 12/);
  const plain = renderToStaticMarkup(createElement(DecisionCarousel, { decisions: [card(1)], flagged: new Map(), onOpenConflict: () => {} }));
  assert.doesNotMatch(plain, /결정이 엇갈렸어요/);
});

test("보기 전환 버튼: 회전 보기 / 목록 보기 두 개, 고른 쪽만 선택됨", () => {
  const html = renderToStaticMarkup(createElement(BoardViewToggle, { value: "carousel", onChange: () => {} }));
  assert.match(html, /role="radiogroup" aria-label="결정 보기 방식"/);
  assert.match(html, /aria-checked="true"[^>]*>회전 보기</);
  assert.match(html, /aria-checked="false"[^>]*>목록 보기</);
  const list = renderToStaticMarkup(createElement(BoardViewToggle, { value: "list", onChange: () => {} }));
  assert.match(list, /aria-checked="true"[^>]*>목록 보기</);
});
