// 자료 올리기: 구획 → 수집기 발화 (src/lib/file-import/messages.ts). 수집기와 맞춘 id·turnId·시각 규칙을 고정한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { sha256Hex, sourceIdOf, isoWithOffset, buildMessages } = load("@/lib/file-import/messages");
const { MAX_CHUNK_CHARS } = load("@/lib/file-import/text");

const nodeSha = (data) => createHash("sha256").update(data).digest("hex");

test("sourceId: 파일 바이트 SHA-256 의 앞 16자리(16진수)", async () => {
  const bytes = new TextEncoder().encode("회의록 본문");
  assert.equal(await sourceIdOf(bytes), nodeSha(bytes).slice(0, 16));
  assert.match(await sourceIdOf(bytes), /^[0-9a-f]{16}$/);
  // ArrayBuffer 도 같은 값
  assert.equal(await sourceIdOf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), nodeSha(bytes).slice(0, 16));
  assert.equal(await sha256Hex("조각"), nodeSha("조각"));
});

test("sourceId: 큰 버퍼의 일부 뷰는 그 부분만 해시한다", async () => {
  const whole = new TextEncoder().encode("앞쪽XXXX본문뒤쪽");
  const view = whole.subarray(whole.indexOf(88), whole.indexOf(88) + 4); // 'XXXX'
  assert.equal(await sourceIdOf(view), nodeSha("XXXX").slice(0, 16));
});

test("isoWithOffset: 시간대 오프셋을 붙인 벽시계 시각", () => {
  const utc = Date.UTC(2026, 10, 15, 1, 30, 5); // 2026-11-15T01:30:05Z
  assert.equal(isoWithOffset(utc, 540), "2026-11-15T10:30:05+09:00");
  assert.equal(isoWithOffset(utc, 0), "2026-11-15T01:30:05+00:00");
  assert.equal(isoWithOffset(utc, -300), "2026-11-14T20:30:05-05:00");
  assert.equal(isoWithOffset(utc, 330), "2026-11-15T07:00:05+05:30");
  assert.match(isoWithOffset(utc), /^2026-11-1[45]T\d\d:\d\d:05[+-]\d\d:\d\d$/); // 이 환경의 시간대
});

test("isoWithOffset: 같은 시각을 가리킨다 (Date.parse 로 되돌려도 같다)", () => {
  const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
  for (const offset of [540, 0, -480, 345]) assert.equal(Date.parse(isoWithOffset(ms, offset)), ms);
});

test("isoWithOffset: lastModified 가 0·NaN 이면 지금 시각으로", () => {
  const before = Date.now();
  for (const bad of [0, NaN, -5]) {
    const at = Date.parse(isoWithOffset(bad));
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000);
  }
});

test("buildMessages: 계약 필드·id·turnId 규칙", async () => {
  const sections = [
    { heading: "[계획서.pdf · 1쪽]", text: "첫 쪽 내용", index: 0 },
    { heading: "[계획서.pdf · 3쪽]", text: "셋째 쪽 내용", index: 2 }, // 둘째 쪽은 읽지 못했다 → 번호는 밀리지 않는다
  ];
  const { messages, truncated } = await buildMessages({ sourceId: "0123456789abcdef", sections, collectedAt: "2026-11-15T10:00:00+09:00" });
  assert.equal(truncated, false);
  assert.equal(messages.length, 2);
  const [a, b] = messages;
  assert.deepEqual(Object.keys(a).sort(), ["collectedAt", "conversationId", "id", "role", "site", "text", "turnId"]);
  assert.equal(a.text, "[계획서.pdf · 1쪽]\n첫 쪽 내용");
  assert.equal(a.site, "file-upload");
  assert.equal(a.role, "user");
  assert.equal(a.conversationId, "file-upload:0123456789abcdef");
  assert.equal(a.collectedAt, "2026-11-15T10:00:00+09:00");
  assert.equal(a.turnId, "file-upload:0123456789abcdef:0");
  assert.equal(b.turnId, "file-upload:0123456789abcdef:2");
  assert.equal(a.id, `file-upload:0123456789abcdef:${nodeSha(a.text).slice(0, 12)}:0`);
  assert.match(b.id, /^file-upload:0123456789abcdef:[0-9a-f]{12}:0$/);
});

test("buildMessages: index 가 없으면 목록 위치, 긴 구획은 조각마다 제목이 앞에 오고 조각 번호가 구획 안에서 0부터", async () => {
  const long = Array.from({ length: 10 }, (_, i) => `문단${i} ${"가".repeat(800)}.`).join("\n\n");
  const { messages } = await buildMessages({
    sourceId: "aaaaaaaaaaaaaaaa",
    sections: [
      { heading: "# 하나", text: "짧다" },
      { heading: "## 둘", text: long },
    ],
    collectedAt: "2026-11-15T10:00:00+09:00",
  });
  const second = messages.filter((m) => m.turnId.endsWith(":1"));
  assert.ok(second.length >= 4);
  second.forEach((m, i) => {
    assert.ok(m.text.startsWith("## 둘\n"));
    assert.ok(m.text.length <= MAX_CHUNK_CHARS);
    assert.ok(m.id.endsWith(`:${i}`));
  });
  assert.ok(messages[0].turnId.endsWith(":0"));
  assert.equal(new Set(messages.map((m) => m.id)).size, messages.length);
});

test("buildMessages: 같은 입력이면 같은 id (같은 파일을 다시 올려도 수집기가 중복으로 안다)", async () => {
  const input = { sourceId: "bbbbbbbbbbbbbbbb", sections: [{ heading: "[a.txt]", text: "내용" }], collectedAt: "2026-11-15T10:00:00+09:00" };
  const one = await buildMessages(input);
  const two = await buildMessages(input);
  assert.deepEqual(one.messages, two.messages);
});

test("buildMessages: 한 파일 조각 상한을 넘으면 앞쪽만 만들고 truncated", async () => {
  const sections = Array.from({ length: 5 }, (_, i) => ({ heading: `# ${i}`, text: `내용 ${i}` }));
  const { messages, truncated } = await buildMessages({ sourceId: "cccccccccccccccc", sections, collectedAt: "2026-11-15T10:00:00+09:00", maxChunks: 3 });
  assert.equal(messages.length, 3);
  assert.equal(truncated, true);
});
