// 프로젝트 방향성 기준 (shared/criteria.ts): 빈 값 정리, 규칙 줄 나누기, syncup.json team 읽기
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { cleanCriteria, rulesFromText, criteriaFromState } = load("@shared/criteria");

test("규칙은 한 줄에 하나, 빈 줄은 버린다", () => {
  assert.deepEqual(rulesFromText(" 결정은 팀장 승인 후 확정 \r\n\n개인 일정은 올리지 않기\n"), ["결정은 팀장 승인 후 확정", "개인 일정은 올리지 않기"]);
});

test("빈 값을 빼고, 아무것도 없으면 undefined (팀 보드에서 숨김)", () => {
  assert.equal(cleanCriteria({ teamGoal: "  ", teamScope: "", teamRules: [" "] }), undefined);
  assert.deepEqual(cleanCriteria({ teamGoal: " MVP 제출 ", teamRules: [] }), { teamGoal: "MVP 제출" });
});

test("syncup.json 의 team(goal·scope·rules)을 같은 기준으로 읽는다", () => {
  assert.deepEqual(criteriaFromState({ name: "AI-12team", goal: "MVP", rules: ["승인 후 공유"] }), { teamGoal: "MVP", teamRules: ["승인 후 공유"] });
  assert.equal(criteriaFromState(undefined), undefined);
  assert.equal(criteriaFromState({ name: "AI-12team" }), undefined);
});
