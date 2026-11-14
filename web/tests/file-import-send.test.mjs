// 자료 올리기: 수집기로 보내기 (src/lib/file-import/send.ts). turns.append 를 200개씩, 마지막에만 flush.
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { sendFileMessages, fileIntakeNotice, APPEND_SLICE } = load("@/lib/file-import/send");

const messages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `file-upload:aaaaaaaaaaaaaaaa:${String(i).padStart(12, "0")}:0`,
    text: `[a.md]\n내용 ${i}`,
    conversationId: "file-upload:aaaaaaaaaaaaaaaa",
    site: "file-upload",
    role: "user",
    collectedAt: "2026-11-15T10:00:00+09:00",
    turnId: `file-upload:aaaaaaaaaaaaaaaa:${i}`,
  }));

const recorder = (answer) => {
  const sent = [];
  const call = async (method, params) => {
    sent.push({ method, params });
    return answer(params);
  };
  return { sent, call };
};

test("200개씩 나눠 turns.append 로 보내고 flush 는 마지막 묶음에만 true", async () => {
  const { sent, call } = recorder((p) => ({ newMessages: p.messages.length }));
  const progress = [];
  const summary = await sendFileMessages(messages(450), { call, onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(APPEND_SLICE, 200);
  assert.deepEqual(sent.map((s) => [s.method, s.params.messages.length, s.params.flush]), [
    ["turns.append", 200, false],
    ["turns.append", 200, false],
    ["turns.append", 50, true],
  ]);
  assert.deepEqual(summary, { sent: 450, stored: 450, quarantined: 0, teamRecord: 0, elsewhere: 0 });
  assert.deepEqual(progress, [[200, 450], [400, 450], [450, 450]]);
});

test("딱 200개면 한 번에 flush", async () => {
  const { sent, call } = recorder((p) => ({ newMessages: p.messages.length }));
  await sendFileMessages(messages(200), { call });
  assert.deepEqual(sent.map((s) => s.params.flush), [true]);
});

test("보낸 발화는 계약 필드 그대로 (site file-upload, role user, turnId)", async () => {
  const { sent, call } = recorder(() => ({ newMessages: 1 }));
  await sendFileMessages(messages(1), { call });
  const [m] = sent[0].params.messages;
  assert.deepEqual(Object.keys(m).sort(), ["collectedAt", "conversationId", "id", "role", "site", "text", "turnId"]);
  assert.equal(m.site, "file-upload");
});

test("수집기가 돌려준 개수를 묶음마다 더한다 (보관·팀 기록·다른 곳 중복)", async () => {
  const answers = [
    { newMessages: 150, intakeIssues: [{}, {}], teamRecordSkipped: 1, elsewhereDuplicates: 3 },
    { newMessages: 20 },
  ];
  const { call } = recorder(() => answers.shift());
  const summary = await sendFileMessages(messages(250), { call });
  assert.deepEqual(summary, { sent: 250, stored: 170, quarantined: 2, teamRecord: 1, elsewhere: 3 });
});

test("수집기 오류는 그대로 던진다 (성공처럼 보이지 않게)", async () => {
  const { call } = recorder(() => {
    throw new Error("로컬 수집기 실행 상태와 연결 파일을 확인하세요.");
  });
  await assert.rejects(sendFileMessages(messages(3), { call }), /연결 파일을 확인하세요/);
});

test("fileIntakeNotice: 전부 들어갔을 때만 성공", () => {
  assert.deepEqual(fileIntakeNotice({ sent: 5, stored: 5, quarantined: 0, teamRecord: 0, elsewhere: 0 }), {
    tone: "success",
    text: "5조각을 분류 대기함에 넣었어요. 분류가 끝나면 승인함에 올라와요.",
  });
});

test("fileIntakeNotice: 보관·다른 곳 중복·이미 올린 것이 있으면 경고로 개수를 알린다", () => {
  const n = fileIntakeNotice({ sent: 10, stored: 4, quarantined: 2, teamRecord: 1, elsewhere: 1 });
  assert.equal(n.tone, "warning");
  assert.match(n.text, /^4조각을 분류 대기함에 넣었어요\./);
  assert.match(n.text, /2조각은 형식이 맞지 않거나 .* 수집기에 따로 보관했어요/);
  assert.match(n.text, /1조각은 팀 기록이라 뺐어요/);
  assert.match(n.text, /1조각은 다른 자료에서 이미 보낸 내용이라 뺐어요/);
  assert.match(n.text, /2조각은 이미 올린 내용이에요/); // 10 - 4 - 2 - 1 - 1
});

test("fileIntakeNotice: 하나도 안 들어갔으면 성공이라고 하지 않는다 (같은 파일을 다시 올린 경우)", () => {
  const n = fileIntakeNotice({ sent: 3, stored: 0, quarantined: 0, teamRecord: 0, elsewhere: 0 });
  assert.equal(n.tone, "warning");
  assert.equal(n.text, "새로 넣은 내용이 없어요. 3조각은 이미 올린 내용이에요.");
});
