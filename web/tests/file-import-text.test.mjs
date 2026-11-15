// 자료 올리기: 본문 정리·조각 나누기·읽지 못한 쪽 문구 (src/lib/file-import/text.ts, unread.ts)
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { normalizeText, chunkText, chunkSection, nonSpaceLength, cleanHeading, MAX_CHUNK_CHARS } = load("@/lib/file-import/text");
const { formatPageList, groupUnread } = load("@/lib/file-import/unread");

const para = (label, n) => `${label} ${"가".repeat(n)}.`;

test("normalizeText: NFC·줄바꿈·제어 문자·빈 줄 정리", () => {
  const decomposed = "한"; // 한 (자모 분리)
  assert.equal(normalizeText(`${decomposed}\r\n본문 \u0000끝  \n\n\n\n다음 줄​`), "한\n본문 끝\n\n다음 줄");
});

test("nonSpaceLength: 공백·줄바꿈을 뺀 글자 수", () => {
  assert.equal(nonSpaceLength(" 가 나\n다\t"), 3);
});

test("cleanHeading: 한 줄로, 너무 길면 자른다", () => {
  assert.equal(cleanHeading("  [a.pdf ·\n 3쪽] "), "[a.pdf · 3쪽]");
  const long = cleanHeading("제".repeat(500));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});

test("chunkText: 짧으면 그대로, 길면 문단 경계에서 2000자 이하로 나눈다", () => {
  assert.deepEqual(chunkText("짧은 글", 2000), ["짧은 글"]);
  const text = [para("가", 900), para("나", 900), para("다", 900), para("라", 900)].join("\n\n");
  const chunks = chunkText(text, 2000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.equal(chunks[0], `${para("가", 900)}\n\n${para("나", 900)}`); // 문단을 쪼개지 않는다
  assert.equal(chunks.join("\n\n"), text);
});

test("chunkText: 한 문단이 길면 줄 → 문장 순으로 나누고, 어느 조각도 상한을 넘지 않는다", () => {
  const sentences = Array.from({ length: 80 }, (_, i) => `${i + 1}번째 문장은 이렇게 끝납니다.`).join(" ");
  const chunks = chunkText(sentences, 300);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 300 && c.endsWith(".")), "문장 끝에서 자른다");
  assert.equal(chunks.join("").replace(/\s/g, ""), sentences.replace(/\s/g, "")); // 글자는 하나도 빠지지 않는다

  const lines = Array.from({ length: 40 }, (_, i) => `줄 ${i}`).join("\n");
  const byLine = chunkText(lines, 100);
  assert.ok(byLine.every((c) => c.length <= 100));
  assert.equal(byLine.join("").replace(/\s/g, ""), lines.replace(/\s/g, ""));
});

test("chunkText: 띄어쓰기도 문장 끝도 없으면 상한에서 자르되 서로게이트 쌍은 깨지 않는다", () => {
  const emoji = "😀".repeat(1500); // 3000 UTF-16 단위
  const chunks = chunkText(emoji, 1001);
  assert.ok(chunks.every((c) => c.length <= 1001));
  assert.equal(chunks.join(""), emoji);
  assert.ok(chunks.every((c) => !/[\ud800-\udbff]$/.test(c) && !/^[\udc00-\udfff]/.test(c)));
});

test("chunkSection: 모든 조각이 제목 줄로 시작하고 제목 포함 2000자 이하다", () => {
  const body = Array.from({ length: 12 }, (_, i) => para(`문단${i}`, 700)).join("\n\n");
  const chunks = chunkSection({ heading: "## 설계 원칙", text: body });
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.ok(c.startsWith("## 설계 원칙\n"));
    assert.ok(c.length <= MAX_CHUNK_CHARS);
  }
});

test("chunkSection: 한 조각이면 제목 + 본문, 본문이 비면 조각이 없다", () => {
  assert.deepEqual(chunkSection({ heading: "[a.txt]", text: "내용" }), ["[a.txt]\n내용"]);
  assert.deepEqual(chunkSection({ heading: "[a.txt]", text: " \n " }), []);
});

test("chunkSection: repeat(표 머리글)는 둘째 조각부터 제목 밑에 다시 붙는다", () => {
  const header = "이름\t역할\t마감";
  const rows = Array.from({ length: 200 }, (_, i) => `사람${i}\t담당 업무 설명 ${i}\t11/${(i % 28) + 1}`).join("\n");
  const chunks = chunkSection({ heading: "[표.xlsx · 시트1]", text: `${header}\n${rows}`, repeat: header });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].startsWith(`[표.xlsx · 시트1]\n${header}\n사람0`));
  for (const c of chunks.slice(1)) assert.ok(c.startsWith(`[표.xlsx · 시트1]\n${header}\n`), "머리글 반복");
  assert.ok(chunks.every((c) => c.length <= MAX_CHUNK_CHARS));
});

test("formatPageList: 이어진 쪽은 범위로", () => {
  assert.equal(formatPageList([3]), "3쪽");
  assert.equal(formatPageList([7, 3, 5, 6, 3]), "3, 5–7쪽");
  assert.equal(formatPageList([1, 2, 3, 9]), "1–3, 9쪽");
});

test("groupUnread: 이유별로 묶고 쪽 수를 센다", () => {
  const groups = groupUnread([
    { page: 2, reason: "model_unavailable" },
    { page: 3, reason: "empty" },
    { page: 4, reason: "model_unavailable" },
    { page: 5, reason: "rpc_error", detail: "시간 초과" },
    { page: 6, reason: "rpc_error" },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.reason, g.pages, g.count, g.detail]),
    [
      ["model_unavailable", "2, 4쪽", 2, undefined],
      ["empty", "3쪽", 1, undefined],
      ["rpc_error", "5–6쪽", 2, "시간 초과"],
    ],
  );
  assert.match(groups[0].label, /글자 인식 AI/);
});
