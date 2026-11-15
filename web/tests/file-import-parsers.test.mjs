// 자료 올리기: 파일 읽기 (src/lib/file-import/{markdown,docx,xlsx,hwpx,decode,detect,import-file}.ts)
// docx·xlsx·hwpx 는 시험 안에서 JSZip 으로 아주 작게 만들어 쓴다.
import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { load } from "./load-ts.mjs";

const { parseMarkdown, parsePlainText } = load("@/lib/file-import/markdown");
const { parseDocx } = load("@/lib/file-import/docx");
const { parseXlsx, excelSerialToText, MAX_ROWS_PER_SHEET } = load("@/lib/file-import/xlsx");
const { parseHwpx } = load("@/lib/file-import/hwpx");
const { decodeText } = load("@/lib/file-import/decode");
const { detectKind } = load("@/lib/file-import/detect");
const { readFileForUpload } = load("@/lib/file-import/import-file");
const { parseXml, decodeEntities } = load("@/lib/file-import/xml");

const zipOf = async (files) => {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "arraybuffer" });
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── xml ──
test("xml: 태그·속성·엔티티·CDATA·자기 닫는 태그를 읽는다", () => {
  const root = parseXml(`<?xml version="1.0"?><a x="1 &amp; 2"><!-- 주석 --><b/><c>가&lt;나&#44032;&#x4E2D;<![CDATA[<raw>]]></c></a>`);
  const a = root.children[0];
  assert.equal(a.name, "a");
  assert.equal(a.attrs.x, "1 & 2");
  assert.deepEqual(a.children.map((n) => n.name), ["b", "c"]);
  assert.equal(a.children[1].children.map((n) => n.text).join(""), "가<나가中<raw>");
  assert.equal(decodeEntities("&unknown; &amp;"), "&unknown; &");
});

// ── markdown ──
test("markdown: #~### 제목마다 구획, 제목 줄은 마크다운 그대로, 제목 앞 글은 [파일명] 구획", () => {
  const md = ["머리말 한 줄", "", "# 제품 개요", "개요 본문", "", "## 설계 원칙", "- 원칙 1", "- 원칙 2", "", "### 세부", "세부 본문", "", "#### 네 단계는 나누지 않는다", "그대로 본문"].join("\n");
  const { sections, warnings } = parseMarkdown(md, "기획.md");
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    sections.map((s) => [s.heading, s.index]),
    [
      ["[기획.md]", 0],
      ["# 제품 개요", 1],
      ["## 설계 원칙", 2],
      ["### 세부", 3],
    ],
  );
  assert.equal(sections[0].text, "머리말 한 줄");
  assert.equal(sections[2].text, "- 원칙 1\n- 원칙 2");
  assert.match(sections[3].text, /#### 네 단계는 나누지 않는다\n그대로 본문$/);
});

test("markdown: 코드 블록 안의 # 줄은 제목이 아니고, 본문이 빈 제목은 빠지되 번호는 밀리지 않는다", () => {
  const md = ["# 빈 제목", "## 코드가 있는 절", "```bash", "# 주석일 뿐", "echo hi", "```", "## 마지막", "끝"].join("\n");
  const { sections } = parseMarkdown(md, "a.md");
  assert.deepEqual(sections.map((s) => [s.heading, s.index]), [["## 코드가 있는 절", 2], ["## 마지막", 3]]);
  assert.match(sections[0].text, /# 주석일 뿐/);
});

test("markdown: 닫는 # 은 뗀다 · 제목 안의 # 은 남긴다 · 공백 없는 #제목 은 본문", () => {
  const { sections } = parseMarkdown("# C# 입문 #\n본문\n#해시태그", "a.md");
  assert.equal(sections[0].heading, "# C# 입문");
  assert.match(sections[0].text, /#해시태그/);
});

test("markdown: 내용이 없으면 구획이 없다", () => {
  assert.deepEqual(parseMarkdown("  \n\n", "a.md").sections, []);
});

test("txt: 한 덩어리면 [파일명] 구획 하나, 길면 빈 줄 문단을 묶어 1800자쯤 구획으로", () => {
  assert.deepEqual(parsePlainText("가나다\n\n라마바", "메모.txt").sections.map((s) => [s.heading, s.text]), [["[메모.txt]", "가나다\n\n라마바"]]);
  const paragraphs = Array.from({ length: 10 }, (_, i) => `문단${i} ${"나".repeat(600)}`);
  const { sections } = parsePlainText(paragraphs.join("\n\n"), "긴글.txt");
  assert.ok(sections.length >= 4);
  assert.deepEqual(sections.map((s) => s.heading).slice(0, 2), ["[긴글.txt · 1번째 부분]", "[긴글.txt · 2번째 부분]"]);
  assert.ok(sections.every((s) => s.text.length <= 1800));
  assert.equal(sections.map((s) => s.text).join("\n\n"), paragraphs.join("\n\n"));
});

// ── 인코딩 ──
test("decodeText: UTF-8(BOM 포함)·UTF-16·CP949(EUC-KR)를 읽는다", () => {
  const utf8 = new TextEncoder().encode("한글");
  assert.equal(decodeText(utf8), "한글");
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])), "한글");
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x5c, 0xd5, 0x00, 0xae])), "한글"); // UTF-16LE
  assert.equal(decodeText(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb])), "한글"); // CP949
});

// ── docx ──
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text, { style, list } = {}) =>
  `<w:p>${style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const cell = (text) => `<w:tc><w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p></w:tc>`;
const docxBody = (inner) => `<?xml version="1.0"?><w:document ${W}><w:body>${inner}</w:body></w:document>`;

test("docx: Heading1~3 마다 구획, 문단은 순서대로, 목록은 '- ', 표는 탭으로 나눈 줄", async () => {
  const bytes = await zipOf({
    "word/document.xml": docxBody(
      para("서문 문단") +
        para("1. 배경", { style: "Heading1" }) +
        para("배경 설명 & 근거") +
        para("항목 하나", { list: true }) +
        `<w:tbl><w:tr>${cell("이름")}${cell("역할")}</w:tr><w:tr>${cell("지우")}${cell("")}${cell("무시")}</w:tr></w:tbl>` +
        para("1.1 세부", { style: "Heading2" }) +
        '<w:p><w:r><w:t>탭</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>구분</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>줄바꿈</w:t></w:r></w:p>' +
        para("네 번째 단계는 제목이 아니다", { style: "Heading4" }),
    ),
  });
  const { sections, warnings } = await parseDocx(bytes, "보고서.docx");
  assert.deepEqual(warnings, []);
  assert.deepEqual(sections.map((s) => [s.heading, s.index]), [["[보고서.docx]", 0], ["# 1. 배경", 1], ["## 1.1 세부", 2]]);
  assert.equal(sections[0].text, "서문 문단");
  assert.equal(sections[1].text, "배경 설명 & 근거\n- 항목 하나\n이름\t역할\n지우\t\t무시");
  assert.equal(sections[2].text, "탭\t구분\n줄바꿈\n네 번째 단계는 제목이 아니다");
});

test("docx: styles.xml 의 스타일 이름·outlineLvl 로 제목을 알아본다 (한국어 Word 의 제목 1)", async () => {
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="a3"><w:name w:val="제목 1"/></w:style><w:style w:type="paragraph" w:styleId="x9"><w:name w:val="내 스타일"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`;
  const bytes = await zipOf({ "word/document.xml": docxBody(para("큰 제목", { style: "a3" }) + para("본문1") + para("작은 제목", { style: "x9" }) + para("본문2")), "word/styles.xml": styles });
  const { sections } = await parseDocx(bytes, "a.docx");
  assert.deepEqual(sections.map((s) => [s.heading, s.text]), [["# 큰 제목", "본문1"], ["## 작은 제목", "본문2"]]);
});

test("docx: 삭제된 글(w:delText)·대체 표현(mc:Fallback)은 읽지 않는다", async () => {
  const p = `<w:p><w:r><w:t>남는 글</w:t></w:r><w:del><w:r><w:delText>지운 글</w:delText></w:r></w:del><mc:AlternateContent xmlns:mc="x"><mc:Choice><w:r><w:t>선택</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>대체</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>`;
  const { sections } = await parseDocx(await zipOf({ "word/document.xml": docxBody(p) }), "a.docx");
  assert.equal(sections[0].text, "남는 글선택");
});

test("docx: 문서가 아니거나 글이 없으면 알아듣게 알린다", async () => {
  await assert.rejects(parseDocx(await zipOf({ "other.txt": "x" }), "a.docx"), /Word 문서가 아니에요/);
  await assert.rejects(parseDocx(new TextEncoder().encode("zip 이 아님").buffer, "a.docx"), /열 수 없어요/);
  const { sections, warnings } = await parseDocx(await zipOf({ "word/document.xml": docxBody("") }), "a.docx");
  assert.deepEqual(sections, []);
  assert.match(warnings[0], /읽을 수 있는 글이 없어요/);
});

// ── xlsx ──
const cellXml = (ref, { t, v, s, inline } = {}) => `<c r="${ref}"${s !== undefined ? ` s="${s}"` : ""}${t ? ` t="${t}"` : ""}>${inline !== undefined ? `<is><t>${esc(inline)}</t></is>` : `<v>${v}</v>`}</c>`;
const rowXml = (n, cells) => `<row r="${n}">${cells.join("")}</row>`;
const sheetXml = (rows) => `<?xml version="1.0"?><worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
const workbookXml = (sheets, extra = "") =>
  `<workbook xmlns:r="r"><workbookPr${extra}/><sheets>${sheets.map(([name, id, state]) => `<sheet name="${esc(name)}" sheetId="${id}"${state ? ` state="${state}"` : ""} r:id="rId${id}"/>`).join("")}</sheets></workbook>`;
const rels = (n) => `<Relationships>${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;

test("xlsx: 시트마다 구획, 공유 문자열·숫자·날짜·참거짓·인라인 문자열, 빈 칸은 탭으로 자리를 지킨다", async () => {
  const shared = `<sst><si><t>이름</t></si><si><r><t>마감</t></r><r><t>일</t></r></si><si><t>지우</t></si><si><t>담당</t><rPh><t>タントウ</t></rPh></si></sst>`;
  const styles = `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;년&quot; m&quot;월&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>`;
  const sheet1 = sheetXml([
    rowXml(1, [cellXml("A1", { t: "s", v: 0 }), cellXml("B1", { t: "s", v: 1 }), cellXml("D1", { t: "s", v: 3 })]),
    rowXml(2, [cellXml("A2", { t: "s", v: 2 }), cellXml("B2", { s: 1, v: 46000 }), cellXml("C2", { s: 3, v: "1234.5678901234567" }), cellXml("D2", { t: "b", v: 1 })]),
    rowXml(3, []), // 빈 행은 건너뜀
    rowXml(4, [cellXml("A4", { t: "inlineStr", inline: "인라인 & 값" }), cellXml("C4", { s: 2, v: 46000 })]),
  ]);
  const bytes = await zipOf({
    "xl/workbook.xml": workbookXml([["일정", 1]]),
    "xl/_rels/workbook.xml.rels": rels(1),
    "xl/sharedStrings.xml": shared,
    "xl/styles.xml": styles,
    "xl/worksheets/sheet1.xml": sheet1,
  });
  const { sections, warnings } = await parseXlsx(bytes, "일정.xlsx");
  assert.deepEqual(warnings, []);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "[일정.xlsx · 일정]");
  assert.equal(sections[0].repeat, "이름\t마감일\t\t담당"); // 머리글 행
  assert.equal(
    sections[0].text,
    ["이름\t마감일\t\t담당", `지우\t${excelSerialToText(46000)}\t1234.56789012\tTRUE`, `인라인 & 값\t\t${excelSerialToText(46000)}`].join("\n"),
  );
  assert.equal(excelSerialToText(46000), "2025-12-09");
});

test("excelSerialToText: 날짜·날짜와 시각·시각만·1904 시스템", () => {
  assert.equal(excelSerialToText(45292), "2024-01-01");
  assert.equal(excelSerialToText(45292.5), "2024-01-01 12:00");
  assert.equal(excelSerialToText(0.75), "18:00");
  assert.equal(excelSerialToText(45292 - 1462, true), "2024-01-01");
});

test("xlsx: 숨긴 시트는 읽지 않고 알린다, 구획 번호는 시트 위치", async () => {
  const bytes = await zipOf({
    "xl/workbook.xml": workbookXml([["공개", 1], ["숨김", 2, "hidden"], ["셋째", 3]]),
    "xl/_rels/workbook.xml.rels": rels(3),
    "xl/sharedStrings.xml": "<sst><si><t>값</t></si></sst>",
    "xl/worksheets/sheet1.xml": sheetXml([rowXml(1, [cellXml("A1", { t: "s", v: 0 })])]),
    "xl/worksheets/sheet2.xml": sheetXml([rowXml(1, [cellXml("A1", { t: "s", v: 0 })])]),
    "xl/worksheets/sheet3.xml": sheetXml([rowXml(1, [cellXml("A1", { t: "s", v: 0 })])]),
  });
  const { sections, warnings } = await parseXlsx(bytes, "a.xlsx");
  assert.deepEqual(sections.map((s) => [s.heading, s.index]), [["[a.xlsx · 공개]", 0], ["[a.xlsx · 셋째]", 2]]);
  assert.deepEqual(warnings, ["숨긴 시트 1개는 읽지 않았어요."]);
});

test("xlsx: 시트당 2000행까지만 읽고 경고한다", async () => {
  const rows = Array.from({ length: MAX_ROWS_PER_SHEET + 50 }, (_, i) => rowXml(i + 1, [cellXml(`A${i + 1}`, { v: i + 1 })]));
  const bytes = await zipOf({
    "xl/workbook.xml": workbookXml([["큰 시트", 1]]),
    "xl/_rels/workbook.xml.rels": rels(1),
    "xl/worksheets/sheet1.xml": sheetXml(rows),
  });
  const { sections, warnings } = await parseXlsx(bytes, "big.xlsx");
  assert.equal(sections[0].text.split("\n").length, MAX_ROWS_PER_SHEET);
  assert.deepEqual(warnings, [`시트 '큰 시트' 는 ${MAX_ROWS_PER_SHEET}행까지만 읽었어요.`]);
});

test("xlsx: 관계 파일이 없으면 sheetN.xml 순서로, 엑셀 문서가 아니면 오류", async () => {
  const bytes = await zipOf({ "xl/workbook.xml": workbookXml([["하나", 1]]), "xl/worksheets/sheet1.xml": sheetXml([rowXml(1, [cellXml("A1", { t: "inlineStr", inline: "값" })])]) });
  assert.equal((await parseXlsx(bytes, "a.xlsx")).sections[0].text, "값");
  await assert.rejects(parseXlsx(await zipOf({ "x.txt": "x" }), "a.xlsx"), /Excel 문서가 아니에요/);
});

// ── hwpx ──
test("hwpx: 구역(section) 파일의 글자(hp:t)를 문단 순서로, 표는 탭으로 나눈 줄", async () => {
  const P = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"';
  const p = (text) => `<hp:p><hp:run><hp:t>${esc(text)}</hp:t></hp:run></hp:p>`;
  const tc = (text) => `<hp:tc><hp:subList>${p(text)}</hp:subList></hp:tc>`;
  const table = `<hp:p><hp:run><hp:tbl><hp:tr>${tc("이름")}${tc("역할")}</hp:tr><hp:tr>${tc("하준")}${tc("발표")}</hp:tr></hp:tbl></hp:run></hp:p>`;
  const section = (inner) => `<?xml version="1.0"?><hs:sec ${P} xmlns:hs="s">${inner}</hs:sec>`;
  const bytes = await zipOf({
    "Contents/section1.xml": section(p("둘째 구역")),
    "Contents/section0.xml": section(p("첫 문단") + p("탭<tab>") + table + `<hp:p><hp:run><hp:t>앞<hp:tab/>뒤</hp:t></hp:run></hp:p>`),
  });
  const { sections } = await parseHwpx(bytes, "공문.hwpx");
  assert.deepEqual(sections.map((s) => [s.heading, s.index]), [["[공문.hwpx · 1번째 구역]", 0], ["[공문.hwpx · 2번째 구역]", 1]]);
  assert.equal(sections[0].text, "첫 문단\n탭<tab>\n이름\t역할\n하준\t발표\n앞\t뒤");
  assert.equal(sections[1].text, "둘째 구역");
  await assert.rejects(parseHwpx(await zipOf({ "x.txt": "x" }), "a.hwpx"), /한글\(hwpx\) 문서가 아니에요/);
});

// ── 종류 판별 ──
test("detectKind: 지원 확장자, 그리고 지원하지 않는 형식마다 이유와 대안", () => {
  assert.equal(detectKind("a.MD"), "markdown");
  assert.equal(detectKind("a.markdown"), "markdown");
  assert.equal(detectKind("메모.TXT"), "text");
  for (const [name, kind] of [["a.docx", "docx"], ["a.xlsx", "xlsx"], ["a.pdf", "pdf"], ["a.hwpx", "hwpx"]]) assert.equal(detectKind(name), kind);
  assert.throws(() => detectKind("a.hwp"), /\.hwp.*\.hwpx 나 PDF/);
  assert.throws(() => detectKind("사진.jpg"), /그림 파일은 아직 올릴 수 없어요/);
  assert.throws(() => detectKind("a.doc"), /\.docx/);
  assert.throws(() => detectKind("a.xls"), /\.xlsx/);
  assert.throws(() => detectKind("a.pptx"), /PDF로 내보내서/);
  assert.throws(() => detectKind("a.zip"), /\.zip 형식은 읽을 수 없어요.*md · txt · docx · xlsx · pdf · hwpx/);
  assert.throws(() => detectKind("확장자없음"), /이 형식은 읽을 수 없어요/);
});

// ── 파일 → 발화 ──
const fileOf = (bytes, name, lastModified = Date.UTC(2026, 10, 15, 1, 0, 0)) => new File([bytes], name, { lastModified });

test("readFileForUpload: 마크다운 파일 → 발화 (sourceId·시각·턴 번호)", async () => {
  const bytes = new TextEncoder().encode("# 결정\n금요일에 발표하기로 했다.\n\n## 근거\n일정이 빠듯하다.");
  const result = await readFileForUpload(fileOf(bytes, "회의.md"), { ocr: null });
  assert.equal(result.kind, "markdown");
  assert.match(result.sourceId, /^[0-9a-f]{16}$/);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map((m) => m.text), ["# 결정\n금요일에 발표하기로 했다.", "## 근거\n일정이 빠듯하다."]);
  assert.deepEqual(result.messages.map((m) => m.turnId), [`file-upload:${result.sourceId}:1`, `file-upload:${result.sourceId}:2`]);
  assert.ok(result.messages.every((m) => m.conversationId === `file-upload:${result.sourceId}` && /[+-]\d\d:\d\d$/.test(m.collectedAt)));
  assert.equal(result.unread.length, 0);
});

test("readFileForUpload: docx 파일", async () => {
  const bytes = await zipOf({ "word/document.xml": docxBody(para("제목", { style: "Heading1" }) + para("본문")) });
  const result = await readFileForUpload(fileOf(bytes, "a.docx"), { ocr: null });
  assert.deepEqual(result.messages.map((m) => m.text), ["# 제목\n본문"]);
});

test("readFileForUpload: 지원하지 않는 형식·빈 파일·너무 큰 파일은 한국어 오류", async () => {
  await assert.rejects(readFileForUpload(fileOf("x", "a.hwp"), { ocr: null }), /\.hwpx 나 PDF/);
  await assert.rejects(readFileForUpload(fileOf("", "a.txt"), { ocr: null }), /빈 파일이에요/);
  const big = { name: "big.pdf", size: 51 * 1024 * 1024, lastModified: 1, arrayBuffer: async () => assert.fail("읽으면 안 된다") };
  await assert.rejects(readFileForUpload(big, { ocr: null }), /50MB 이하/);
});

test("readFileForUpload: 같은 파일은 sourceId 와 모든 id 가 같다, 내용이 다르면 다르다", async () => {
  const a = await readFileForUpload(fileOf("# 가\n내용", "a.md"), { ocr: null });
  const b = await readFileForUpload(fileOf("# 가\n내용", "복사본.md"), { ocr: null });
  const c = await readFileForUpload(fileOf("# 가\n다른 내용", "a.md"), { ocr: null });
  assert.equal(a.sourceId, b.sourceId); // 파일 이름이 달라도 바이트가 같으면 같은 자료
  assert.deepEqual(a.messages.map((m) => m.id), b.messages.map((m) => m.id)); // 제목 줄에 파일명이 없는 구획은 id 도 같다
  assert.notEqual(a.sourceId, c.sourceId);
  assert.notEqual(a.messages[0].id, c.messages[0].id);
});

test("readFileForUpload: 조각 상한을 넘으면 앞쪽만 올리고 경고", async () => {
  const md = Array.from({ length: 6 }, (_, i) => `# 제목${i}\n본문${i}`).join("\n");
  const result = await readFileForUpload(fileOf(md, "a.md"), { ocr: null, maxChunks: 4 });
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.warnings, ["내용이 많아 앞쪽 4조각까지만 올려요."]);
});
