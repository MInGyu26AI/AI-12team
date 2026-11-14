// 붙여넣기·내보내기 결과 알림 (src/lib/collector-intake.ts intakeNotice): 수집기가 받은 것만 사실대로
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { intakeNotice } = load("@/lib/collector-intake");
const s = (o) => ({ sent: 0, stored: 0, quarantined: 0, teamRecord: 0, elsewhere: 0, ...o });

test("전부 들어갔을 때만 성공", () => {
  assert.deepEqual(intakeNotice(s({ sent: 5, stored: 5 })), { tone: "success", text: "5개를 분류 대기함에 넣었어요. 분류가 끝나면 승인함에 올라와요." });
});

test("보관·팀 기록·다른 대화 중복·이미 보낸 것이 있으면 경고로 개수를 알린다", () => {
  const n = intakeNotice(s({ sent: 10, stored: 5, quarantined: 2, teamRecord: 1, elsewhere: 1 }));
  assert.equal(n.tone, "warning");
  assert.match(n.text, /^5개를 분류 대기함에 넣었어요\./);
  assert.match(n.text, /2개는 형식이 맞지 않거나/);
  assert.match(n.text, /1개는 붙여 넣은 팀 기록이라 뺐어요/);
  assert.match(n.text, /1개는 다른 대화에서 이미 보낸 내용/);
  assert.match(n.text, /1개는 이미 보낸 내용이에요/); // 10 - 5 - 2 - 1 - 1
});

test("하나도 안 들어갔으면 성공이라고 하지 않는다", () => {
  const n = intakeNotice(s({ sent: 3, stored: 0 }));
  assert.equal(n.tone, "warning");
  assert.match(n.text, /^새로 넣은 대화가 없어요\. 3개는 이미 보낸 내용이에요/);
});
