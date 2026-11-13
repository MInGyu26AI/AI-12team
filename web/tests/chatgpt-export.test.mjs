// ChatGPT 내보내기 읽기(src/lib/chatgpt-export.ts) 회귀 시험: 공용 파서(shared/chatgpt-conversation.ts)로 바꾼 뒤에도
// 결과 모양·정렬은 그대로이고, 바뀌는 결과(docs/sync-contract.md 6장 "웹 내보내기")는 하나씩 여기서 확인한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "./load-ts.mjs";

const { readChatGPTExport } = load("@/lib/chatgpt-export");
const { formatSource } = load("@shared/format");

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../extension/tests/fixtures/chatgpt");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

const T0 = 1762995600; // 2025-11-13T01:00:00Z

const msg = (id, role, parts, sec, extra = {}) => ({
  id,
  author: { role },
  recipient: "all",
  create_time: sec,
  content: { content_type: "text", parts: Array.isArray(parts) ? parts : [parts] },
  status: "finished_successfully",
  end_turn: role === "assistant" ? true : null,
  metadata: {},
  ...extra,
});

/** 메시지를 한 줄로 이은 대화 (current_node = 마지막) */
const conv = (messages, extra = {}) => {
  const mapping = {};
  messages.forEach((m, i) => {
    mapping[m.id] = { id: m.id, parent: i ? messages[i - 1].id : null, children: i < messages.length - 1 ? [messages[i + 1].id] : [], message: m };
  });
  return { id: "conv-1", title: "합성 대화", create_time: T0, current_node: messages.at(-1).id, mapping, ...extra };
};

const read = (data, name = "conversations.json") => readChatGPTExport(new File([JSON.stringify(data)], name));
const textsOf = async (data) => (await read([data]))[0]?.utterances.map((u) => u.text) ?? [];
const idsOf = async (data) => (await read([data]))[0]?.utterances.map((u) => u.id) ?? [];

// ── 그대로인 것 ──

test("결과 모양: 대화마다 {id, title, date, utterances} 이고 발화는 출처·화자·시각을 갖는다", async () => {
  const data = conv([msg("u1", "user", "금요일로 하자", T0 + 1.2), msg("a1", "assistant", "좋아요", T0 + 5)]);
  const [c, ...rest] = await read([data]);
  assert.equal(rest.length, 0);
  assert.equal(c.id, "0");
  assert.equal(c.title, "합성 대화");
  assert.ok(c.date instanceof Date);
  assert.equal(c.date.toISOString(), "2025-11-13T01:00:00.000Z");
  const at1 = new Date("2025-11-13T01:00:01.200Z");
  const at2 = new Date("2025-11-13T01:00:05.000Z");
  assert.deepEqual(c.utterances, [
    { id: "u1", conversationId: "conv-1", collectedAt: at1.toISOString(), roleGuessed: false, speaker: "user", text: "금요일로 하자", source: formatSource("ChatGPT", at1) },
    { id: "a1", conversationId: "conv-1", collectedAt: at2.toISOString(), roleGuessed: false, speaker: "ai", text: "좋아요", source: formatSource("ChatGPT", at2) },
  ]);
});

test("정렬: 대화 시각이 최신인 것이 먼저, 발화가 없는 대화는 빠진다, 제목이 없으면 (제목 없음)", async () => {
  const older = conv([msg("o1", "user", "옛 대화", T0 - 1000)], { id: "old", title: "옛", create_time: T0 - 1000 });
  const newer = conv([msg("n1", "user", "새 대화", T0 + 1000)], { id: "new", title: "  ", create_time: T0 + 1000 });
  const empty = conv([msg("e1", "tool", "빠짐", T0 + 2000)], { id: "empty", title: "빈 대화", create_time: T0 + 2000 });
  const result = await read([older, empty, newer]);
  assert.deepEqual(result.map((c) => c.title), ["(제목 없음)", "옛"]);
  assert.deepEqual(result.map((c) => c.id), ["2", "0"]); // id 는 파일 안 순서
});

test("대화 id 가 없으면 export-<create_time>-<순번> 을 쓴다", async () => {
  const data = conv([msg("u1", "user", "안녕", T0)]);
  delete data.id;
  const [c] = await read([data]);
  assert.equal(c.utterances[0].conversationId, `export-${T0}-0`);
});

test("시각이 없는 메시지는 대화 시각, 그것도 없으면 지금 시각으로 채운다", async () => {
  const withConvTime = conv([msg("u1", "user", "시각 없음", null)]);
  const [a] = await read([withConvTime]);
  assert.equal(a.utterances[0].collectedAt, "2025-11-13T01:00:00.000Z");

  const neither = conv([msg("u1", "user", "시각 없음", null)]);
  delete neither.create_time;
  const before = Date.now();
  const [b] = await read([neither]);
  const filled = Date.parse(b.utterances[0].collectedAt);
  assert.ok(filled >= before - 1000 && filled <= Date.now() + 1000);
  assert.equal(b.date, null);
});

test("연결 구조가 돌면 지금처럼 같은 문구의 Error", async () => {
  const data = conv([msg("u1", "user", "질문", T0), msg("a1", "assistant", "답", T0 + 1)]);
  data.mapping.u1.parent = "a1";
  await assert.rejects(() => read([data]), { message: "대화 파일의 연결 구조가 잘못되었습니다." });
});

test("파일 형식 검사는 그대로: 배열이 아니면 거절, 50MB 초과 거절", async () => {
  await assert.rejects(() => read({ not: "array" }), { message: "ChatGPT 내보내기 형식이 아니에요" });
  await assert.rejects(() => readChatGPTExport({ size: 51 * 1024 * 1024, name: "conversations.json" }), { message: "50MB 이하 파일을 선택하세요." });
});

test("정상 대화는 공용 파서 기준 픽스처(expected-basic)와 메시지 id·화자·본문이 같다", async () => {
  const [c] = await read([fixture("conversation-basic.json")]);
  const expected = fixture("expected-basic.json").turns.flatMap((t) => t.messages);
  assert.deepEqual(
    c.utterances.map((u) => [u.id, u.speaker === "user" ? "user" : "assistant", u.text, u.collectedAt]),
    expected.map((m) => [m.id, m.role, m.text, m.createdAt]),
  );
});

// ── 바뀌는 것 (docs/sync-contract.md 6장 "웹 내보내기") ──

test("바뀜 1: 도구에 보내는 말(recipient)이 빠진다", async () => {
  const data = conv([
    msg("u1", "user", "계산해 줘", T0),
    msg("a-tool", "assistant", "print(6*7)", T0 + 1, { recipient: "python" }),
    msg("a1", "assistant", "42 입니다", T0 + 3),
  ]);
  assert.deepEqual(await idsOf(data), ["u1", "a1"]); // 전에는 a-tool 도 들어왔다
});

test("바뀜 2: code·execution_output·tether 같은 도구 출력과 맞춤 지침이 빠진다", async () => {
  for (const contentType of ["code", "execution_output", "tether_browsing_display", "user_editable_context", "model_editable_context", "reasoning_recap"]) {
    const data = conv([
      msg("u1", "user", "질문", T0),
      msg("x", "assistant", "본문이 있어도", T0 + 1, { content: { content_type: contentType, parts: ["본문이 있어도"] } }),
      msg("a1", "assistant", "답", T0 + 2),
    ]);
    assert.deepEqual(await idsOf(data), ["u1", "a1"], contentType);
  }
});

test("바뀜 3: 숨김·생각 머리말·생각(thoughts) 메시지가 빠진다", async () => {
  const data = conv([
    msg("u1", "user", "질문", T0),
    msg("hidden", "assistant", "화면에 안 보이는 말", T0 + 1, { metadata: { is_visually_hidden_from_conversation: true } }),
    msg("preamble", "assistant", "먼저 생각해 볼게요", T0 + 2, { metadata: { is_thinking_preamble_message: true } }),
    msg("think", "assistant", "추론 과정", T0 + 3, { content: { content_type: "thoughts", parts: ["추론 과정"] } }),
    msg("a1", "assistant", "답", T0 + 4),
  ]);
  assert.deepEqual(await idsOf(data), ["u1", "a1"]);
});

test("바뀜 4: 첨부만 있는 사용자 메시지가 [첨부 N개] 로 들어온다", async () => {
  const data = conv([
    msg("u1", "user", [{ content_type: "image_asset_pointer", asset_pointer: "file-service://x" }, { content_type: "file" }], T0, {
      content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://x" }, { content_type: "file" }] },
    }),
    msg("a1", "assistant", "이미지를 봤어요", T0 + 1),
  ]);
  assert.deepEqual(await textsOf(data), ["[첨부 2개]", "이미지를 봤어요"]); // 전에는 이 메시지가 통째로 빠졌다
});

test("바뀜 5: 글과 첨부가 같이 있으면 맨 앞에 첨부 줄이 붙는다", async () => {
  const parts = [{ content_type: "image_asset_pointer" }, "이 표 정리해 줘"];
  const data = conv([msg("u1", "user", parts, T0, { content: { content_type: "multimodal_text", parts } }), msg("a1", "assistant", "네", T0 + 1)]);
  assert.deepEqual(await textsOf(data), ["[첨부 1개]\n이 표 정리해 줘", "네"]);
});

test("바뀜 6: 인용 표시(content_references)가 지워진다", async () => {
  const data = conv([
    msg("u1", "user", "근거도 알려 줘", T0),
    msg("a1", "assistant", "마감은 금요일입니다 【3†source】", T0 + 1, { metadata: { content_references: [{ matched_text: "【3†source】" }] } }),
  ]);
  assert.deepEqual(await textsOf(data), ["근거도 알려 줘", "마감은 금요일입니다"]); // 전에는 【3†source】 가 본문에 남았다
});

test("바뀜 7: 본문이 비고 위젯 대체 글(fallbackMarkdown)이 있으면 그 글이 본문이 된다", async () => {
  const data = conv([
    msg("u1", "user", "표로 줘", T0),
    msg("a1", "assistant", "", T0 + 1, { metadata: { model_dil_v2: { fallbackMarkdown: "| 항목 | 값 |\n|---|---|\n| 마감 | 금 |" } } }),
  ]);
  assert.deepEqual(await textsOf(data), ["표로 줘", "| 항목 | 값 |\n|---|---|\n| 마감 | 금 |"]); // 전에는 이 답변이 빠졌다
});

test("바뀜 8: 음성 전사(audio_transcription)가 본문으로 들어온다", async () => {
  const parts = [{ content_type: "audio_transcription", text: "음성으로 한 말" }];
  const data = conv([msg("u1", "user", parts, T0, { content: { content_type: "multimodal_text", parts } }), msg("a1", "assistant", "네", T0 + 1)]);
  assert.deepEqual(await textsOf(data), ["음성으로 한 말", "네"]);
});

test("바뀜 9: current_node 가 없는 대화는 자식 없는 가장 늦은 노드를 끝점으로 읽는다", async () => {
  const data = conv([msg("u1", "user", "질문", T0), msg("a1", "assistant", "답", T0 + 1)]);
  delete data.current_node;
  assert.deepEqual(await textsOf(data), ["질문", "답"]); // 전에는 이런 대화가 통째로 빠졌다
});

test("바뀜 10: 메시지 id 는 message.id 를 쓰고 없으면 노드 id 를 쓴다", async () => {
  const data = conv([msg("u1", "user", "질문", T0), msg("a1", "assistant", "답", T0 + 1)]);
  data.mapping.u1.message.id = "message-u1";
  delete data.mapping.a1.message.id;
  assert.deepEqual(await idsOf(data), ["message-u1", "a1"]);
});

test("생성 중인 마지막 답변도 내보내기에서는 그대로 넣는다 (turnsInWindows 를 쓰지 않음)", async () => {
  const [c] = await read([fixture("conversation-in-progress.json")]);
  assert.deepEqual(
    c.utterances.map((u) => [u.id, u.text]),
    [
      ["p-u1", "회의 시간 정하자"],
      ["p-a1", "화요일 3시 어때요?"],
      ["p-u2", "좋아, 안건도 정리해 줘"],
      ["p-a2", "안건은 1)"],
    ],
  );
});

test("답변 노드가 여러 개여도 합치지 않고 각각 발화가 된다", async () => {
  const data = conv([msg("u1", "user", "질문", T0), msg("a1", "assistant", "첫째", T0 + 1, { end_turn: false }), msg("a2", "assistant", "둘째", T0 + 2)]);
  assert.deepEqual(await idsOf(data), ["u1", "a1", "a2"]);
});
