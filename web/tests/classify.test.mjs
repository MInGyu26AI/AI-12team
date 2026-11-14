// 목업 분류(shared/classify.ts mockClassify)의 켤 소주제: 빈 목록 = 모두 켬 (로컬 수집기 기본값 [] 과 ai/syncup_ai/classify.py 와 같음)
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { mockClassify } = load("@shared/classify");

const utter = [{ speaker: "user", text: "화면 디자인은 카드형으로 하자.", source: "ChatGPT, 2026-11-14 20:00" }];
const subtopicWith = (enabledSubtopics) =>
  mockClassify(utter, { userName: "김도윤", ...(enabledSubtopics ? { enabledSubtopics } : {}) }).find((c) => c.relevance === "related")?.subtopic;

test("켤 소주제를 하나도 고르지 않으면(빈 목록) 모든 소주제를 쓴다", () => {
  assert.equal(subtopicWith([]), "작업·결과물"); // 예전에는 빈 Set 이라 모두 '기타'로 갔다
  assert.equal(subtopicWith(undefined), "작업·결과물");
});

test("고른 소주제가 있으면 꺼 둔 소주제는 '기타'로", () => {
  assert.equal(subtopicWith(["작업·결과물"]), "작업·결과물");
  assert.equal(subtopicWith(["주제·목표"]), "기타");
});
