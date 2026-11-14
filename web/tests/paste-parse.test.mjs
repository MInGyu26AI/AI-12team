// 붙여넣기 파서(shared/utterance.ts parsePasted): ChatGPT 한국어·영어 복사 형식의 화자 머리말
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { parsePasted } = load("@shared/utterance");
const roles = (text) => parsePasted(text, "직접 입력").map((u) => [u.speaker, u.text, u.roleGuessed]);

test("ChatGPT 한국어 복사 형식 (나의 말: / ChatGPT의 말:)", () => {
  assert.deepEqual(roles("나의 말:\nMVP 범위는 실내만 하자\nChatGPT의 말:\n좋아요. 실외는 다음 단계로 두죠."), [
    ["user", "MVP 범위는 실내만 하자", false],
    ["ai", "좋아요. 실외는 다음 단계로 두죠.", false],
  ]);
  assert.deepEqual(roles("나의 말: 슬라이드는 채원이가 만들어 줘\nChatGPT의 말: 알겠어요"), [
    ["user", "슬라이드는 채원이가 만들어 줘", false],
    ["ai", "알겠어요", false],
  ]);
});

test("ChatGPT 영어 복사 형식 (You said: / ChatGPT said:)과 짧은 표시도 유지", () => {
  assert.deepEqual(roles("You said:\nlet's ship QR\nChatGPT said:\nSounds good"), [
    ["user", "let's ship QR", false],
    ["ai", "Sounds good", false],
  ]);
  assert.deepEqual(roles("ChatGPT said: inline answer\n나: 결정은 팀장 승인 후"), [
    ["ai", "inline answer", false],
    ["user", "결정은 팀장 승인 후", false],
  ]);
});

test("본문 속 '나의 말이 맞아' 같은 문장은 머리말로 보지 않는다", () => {
  assert.deepEqual(roles("ChatGPT의 말:\n나의 말이 맞아요. 그렇게 하죠."), [["ai", "나의 말이 맞아요. 그렇게 하죠.", false]]);
  assert.deepEqual(roles("표시 없는 첫 줄"), [["user", "표시 없는 첫 줄", true]]);
});
