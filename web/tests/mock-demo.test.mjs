// 공개 시연 목업(shared/mock.ts, 합성 대화 H01 '온길'): 보드에 충돌·변경·확인 필요가 모두 보이고, 실제 사람 이름이 없다
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { createMockApi } = load("@/lib/api/mock");
const { alertLevel } = load("@shared/labels");
const { MOCK_TEAM, DEMO_KNOWN_NAMES, mockCards } = load("@shared/mock");

test("처음 보드에 충돌·변경·확인 필요가 각각 1건 이상 있다", async () => {
  const conflicts = await createMockApi().getConflicts();
  const levels = conflicts.map(alertLevel);
  for (const level of ["conflict", "change", "review"]) assert.ok(levels.includes(level), `${level} 없음: ${levels}`);
  const red = conflicts.find((x) => alertLevel(x) === "conflict");
  assert.equal(red.topic_key, "MVP 범위"); // 정답표 충돌 쌍 (a ↔ b)
});

test("목업 팀원·카드에 실제 팀원 이름이 없다", () => {
  const real = ["김단비", "김하은", "김동균", "김민규"];
  const names = [...MOCK_TEAM.members.map((m) => m.name), ...DEMO_KNOWN_NAMES, ...mockCards.map((c) => c.owner ?? "")];
  assert.deepEqual(names.filter((n) => real.includes(n)), []);
  assert.ok(!JSON.stringify(mockCards).match(/01[0-9]-?\d{3,4}-?\d{4}|@[a-z0-9-]+\./i), "카드에 연락처가 없다");
});
