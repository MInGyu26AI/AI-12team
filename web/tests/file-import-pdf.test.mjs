// 자료 올리기: PDF 흐름 (src/lib/file-import/pdf.ts, ocr.ts). pdf.js 와 수집기 없이 가짜 쪽·가짜 글자 인식으로 시험한다.
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { joinTextItems, cleanPageText, parsePdfPages, MAX_PDF_PAGES, MIN_PAGE_TEXT_CHARS } = load("@/lib/file-import/pdf");
const { matchOcrResults, createOcr } = load("@/lib/file-import/ocr");
const { ExtensionMissing } = load("@/lib/rpc");
const { readFileForUpload } = load("@/lib/file-import/import-file");

// ── 글자 조각 잇기 ──
const item = (str, x, y, extra = {}) => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 10, height: 10, hasEOL: false, ...extra });

test("joinTextItems: 같은 줄은 이어 붙이고, 세로 위치가 바뀌면 줄바꿈, 가로로 떨어졌으면 공백", () => {
  const items = [
    item("회의록", 50, 700),
    item("2026", 150, 700), // 앞 조각 끝(80)에서 70 떨어짐 → 공백
    item("결정", 50, 680),
    item("사항", 70, 680), // 앞 조각 끝(70)에 바로 이어짐 → 공백 없음
    { type: "beginMarkedContent", id: "x" }, // 표시용 마커는 건너뜀
    item("끝", 50, 660, { hasEOL: true }),
    item("다음", 50, 640),
  ];
  assert.equal(joinTextItems(items), "회의록 2026\n결정사항\n끝\n다음");
});

test("joinTextItems: 빈 조각의 줄 끝 표시는 줄바꿈 하나, 이미 줄바꿈이면 더하지 않는다", () => {
  assert.equal(joinTextItems([item("가", 0, 10, { hasEOL: true }), item("", 0, 10, { hasEOL: true }), item("나", 0, 0)]), "가\n나");
});

test("cleanPageText: 줄 안 연속 공백을 하나로", () => {
  assert.equal(cleanPageText("가    나\n\n\n\n다"), "가 나\n\n다");
});

// ── 흐름 ──
const longText = (label) => `${label} ${"가나다라마바사".repeat(5)}`; // 20자 이상
const fakeSource = ({ pages, renderFails = {}, imageSize = 100 }) => {
  const calls = { render: [] };
  return {
    calls,
    numPages: pages.length,
    getText: async (n) => pages[n - 1],
    renderPage: async (n) => {
      calls.render.push(n);
      return renderFails[n] ? { ok: false, reason: renderFails[n] } : { ok: true, image: "x".repeat(imageSize) + n };
    },
  };
};
// 가짜 글자 인식: 쪽 번호별 응답을 돌려주고 호출 기록을 남긴다
const fakeOcr = (answers) => {
  const calls = [];
  const ocr = async (pages) => {
    calls.push(pages.map((p) => p.page));
    return pages.map((p) => {
      const a = typeof answers === "function" ? answers(p.page, calls.length) : answers[p.page];
      return a?.ok === false ? { page: p.page, ...a } : { page: p.page, ok: true, text: a?.text ?? `인식 결과 ${p.page}쪽 ${"글".repeat(30)}` };
    });
  };
  return { ocr, calls };
};

test("글자가 있는 쪽은 그대로, 글자가 거의 없는 쪽만 글자 인식으로 읽는다", async () => {
  const source = fakeSource({ pages: [longText("1쪽 본문"), "  3  ", longText("3쪽 본문"), ""] });
  const { ocr, calls } = fakeOcr({});
  const progress = [];
  const result = await parsePdfPages(source, { fileName: "계획서.pdf", ocr, onProgress: (p) => progress.push(p) });
  assert.deepEqual(source.calls.render, [2, 4]); // 글자 있는 쪽은 그림으로 만들지 않는다
  assert.deepEqual(calls, [[2, 4]]); // 한 번에 두 쪽
  assert.deepEqual(result.sections.map((s) => [s.heading, s.index]), [["[계획서.pdf · 1쪽]", 0], ["[계획서.pdf · 2쪽]", 1], ["[계획서.pdf · 3쪽]", 2], ["[계획서.pdf · 4쪽]", 3]]);
  assert.match(result.sections[1].text, /^인식 결과 2쪽/);
  assert.equal(result.ocrPages, 2);
  assert.equal(result.totalPages, 4);
  assert.deepEqual(result.unread, []);
  assert.deepEqual(progress, [{ done: 0, total: 2 }, { done: 2, total: 2 }, { done: 2, total: 2 }]);
});

test(`글자 수 기준은 공백을 뺀 ${MIN_PAGE_TEXT_CHARS}자`, async () => {
  const nineteen = "가".repeat(MIN_PAGE_TEXT_CHARS - 1);
  const twenty = `${"가".repeat(MIN_PAGE_TEXT_CHARS - 5)}  \n ${"나".repeat(5)}`;
  const source = fakeSource({ pages: [nineteen, twenty] });
  const { ocr, calls } = fakeOcr({});
  const result = await parsePdfPages(source, { fileName: "a.pdf", ocr });
  assert.deepEqual(calls, [[1]]);
  assert.equal(result.sections.length, 2);
});

test("읽지 못한 쪽은 이유와 함께 남고 어디로도 보내지 않으며, 나머지는 계속 이어 간다", async () => {
  const source = fakeSource({ pages: ["", "", "", "", longText("5쪽")], renderFails: { 3: "render_failed" } });
  const { ocr } = fakeOcr({ 1: { ok: false, reason: "empty" }, 2: { ok: false, reason: "bad_image" }, 4: { ok: false, reason: "too_large" } });
  const result = await parsePdfPages(source, { fileName: "스캔.pdf", ocr, pagesPerCall: 1 });
  assert.deepEqual(result.sections.map((s) => s.index), [4]); // 읽은 쪽만 구획, 번호는 쪽 위치
  assert.deepEqual(result.unread, [
    { page: 1, reason: "empty" },
    { page: 2, reason: "bad_image" },
    { page: 3, reason: "render_failed" },
    { page: 4, reason: "too_large" },
  ]);
});

test("글자 인식 결과가 공백뿐이면 empty", async () => {
  const result = await parsePdfPages(fakeSource({ pages: [""] }), { fileName: "a.pdf", ocr: fakeOcr({ 1: { text: "  \n " } }).ocr });
  assert.deepEqual(result.unread, [{ page: 1, reason: "empty" }]);
  assert.deepEqual(result.sections, []);
});

test("모델이 꺼져 있다는 답을 받으면 남은 쪽은 요청하지 않고 같은 이유로 남긴다", async () => {
  const source = fakeSource({ pages: ["", "", "", "", ""] });
  const { ocr, calls } = fakeOcr(() => ({ ok: false, reason: "model_unavailable" }));
  const result = await parsePdfPages(source, { fileName: "a.pdf", ocr });
  assert.deepEqual(calls, [[1, 2]]); // 첫 묶음만
  assert.deepEqual(result.unread.map((u) => [u.page, u.reason]), [1, 2, 3, 4, 5].map((p) => [p, "model_unavailable"]));
  assert.deepEqual(source.calls.render, [1, 2, 3]); // 셋째 쪽은 그리다가 멈춘다 (넷째부터는 그리지도 않는다)
});

test("글자 인식을 쓸 수 없으면(ocr=null) 글자 없는 쪽은 읽지 못한 쪽으로, 글자 있는 쪽은 그대로", async () => {
  const source = fakeSource({ pages: [longText("본문"), ""] });
  const result = await parsePdfPages(source, { fileName: "a.pdf", ocr: null });
  assert.deepEqual(result.unread, [{ page: 2, reason: "ocr_off" }]);
  assert.equal(result.sections.length, 1);
  assert.deepEqual(source.calls.render, []);
});

test("한 번에 보내는 쪽 수와 그림 크기 합을 넘기지 않는다", async () => {
  const source = fakeSource({ pages: ["", "", "", "", ""], imageSize: 40 });
  const { ocr, calls } = fakeOcr({});
  await parsePdfPages(source, { fileName: "a.pdf", ocr, pagesPerCall: 3 });
  assert.deepEqual(calls, [[1, 2, 3], [4, 5]]);

  const big = fakeSource({ pages: ["", "", ""], imageSize: 400 });
  const bySize = fakeOcr({});
  await parsePdfPages(big, { fileName: "a.pdf", ocr: bySize.ocr, pagesPerCall: 10, maxCallChars: 900 }); // 그림 둘 = 802자, 셋 = 1203자
  assert.deepEqual(bySize.calls, [[1, 2], [3]]);
});

test("여러 쪽 요청이 통째로 수집기 오류(rpc_error)면 쪽마다 따로 다시 보낸다", async () => {
  const source = fakeSource({ pages: ["", ""] });
  const calls = [];
  const ocr = async (pages) => {
    calls.push(pages.map((p) => p.page));
    if (pages.length > 1) return pages.map((p) => ({ page: p.page, ok: false, reason: "rpc_error", detail: "시간 초과" }));
    return [{ page: pages[0].page, ok: true, text: `단독 ${pages[0].page} ${"글".repeat(30)}` }];
  };
  const result = await parsePdfPages(source, { fileName: "a.pdf", ocr });
  assert.deepEqual(calls, [[1, 2], [1], [2]]);
  assert.equal(result.sections.length, 2);
  assert.deepEqual(result.unread, []);
});

test("rpc_error 는 응답 문구(detail)와 함께 남는다", async () => {
  const ocr = async (pages) => pages.map((p) => ({ page: p.page, ok: false, reason: "rpc_error", detail: "수집기가 꺼져 있어요" }));
  const result = await parsePdfPages(fakeSource({ pages: [""] }), { fileName: "a.pdf", ocr });
  assert.deepEqual(result.unread, [{ page: 1, reason: "rpc_error", detail: "수집기가 꺼져 있어요" }]);
});

test(`${MAX_PDF_PAGES}쪽까지만 읽고 경고한다`, async () => {
  const pages = Array.from({ length: MAX_PDF_PAGES + 7 }, (_, i) => longText(`${i + 1}쪽`));
  const result = await parsePdfPages(fakeSource({ pages }), { fileName: "a.pdf", ocr: null });
  assert.equal(result.sections.length, MAX_PDF_PAGES);
  assert.equal(result.totalPages, MAX_PDF_PAGES + 7);
  assert.deepEqual(result.warnings, [`앞쪽 ${MAX_PDF_PAGES}쪽까지만 읽었어요 (전체 ${MAX_PDF_PAGES + 7}쪽).`]);
});

test("글자를 읽다 실패한 쪽은 글자 없는 쪽처럼 글자 인식으로 간다", async () => {
  const source = { numPages: 1, getText: async () => Promise.reject(new Error("깨진 쪽")), renderPage: async () => ({ ok: true, image: "x" }) };
  const result = await parsePdfPages(source, { fileName: "a.pdf", ocr: fakeOcr({}).ocr });
  assert.equal(result.ocrPages, 1);
});

// ── 수집기 응답 맞추기 ──
test("matchOcrResults: 요청한 쪽마다 하나씩, 빠졌거나 모양이 다르면 rpc_error", () => {
  const response = {
    model: "m",
    pages: [
      { page: 2, ok: true, text: "둘" },
      { page: 1, ok: false, reason: "empty" },
      { page: 3, ok: false, reason: "이상한 이유" },
      { page: 4, ok: true }, // text 없음
    ],
  };
  assert.deepEqual(matchOcrResults([1, 2, 3, 4, 5], response), [
    { page: 1, ok: false, reason: "empty" },
    { page: 2, ok: true, text: "둘" },
    { page: 3, ok: false, reason: "rpc_error", detail: "알 수 없는 응답이에요" },
    { page: 4, ok: false, reason: "rpc_error", detail: "알 수 없는 응답이에요" },
    { page: 5, ok: false, reason: "rpc_error", detail: "응답에 이 쪽이 없어요" },
  ]);
  assert.deepEqual(matchOcrResults([1], null), [{ page: 1, ok: false, reason: "rpc_error", detail: "응답에 이 쪽이 없어요" }]);
});

test("createOcr: files.ocr 로 {name, pages} 를 보내고, 오류는 쪽별 rpc_error 로 바꾸되 확장 없음은 그대로 던진다", async () => {
  const sent = [];
  const call = async (method, params, timeout) => {
    sent.push({ method, params, timeout });
    return { model: "qwen", pages: [{ page: 7, ok: true, text: "일곱" }] };
  };
  const pages = [{ page: 7, image: "AAAA" }];
  assert.deepEqual(await createOcr("스캔.pdf", call)(pages), [{ page: 7, ok: true, text: "일곱" }]);
  assert.deepEqual(sent[0].params, { name: "스캔.pdf", pages });
  assert.equal(sent[0].method, "files.ocr");
  assert.ok(sent[0].timeout >= 60000);

  const failing = async () => {
    throw new Error("로컬 연결 오류");
  };
  assert.deepEqual(await createOcr("a.pdf", failing)(pages), [{ page: 7, ok: false, reason: "rpc_error", detail: "로컬 연결 오류" }]);
  const missing = async () => {
    throw new ExtensionMissing();
  };
  await assert.rejects(createOcr("a.pdf", missing)(pages), (e) => e instanceof ExtensionMissing);
});

// ── 파일 → 발화 (가짜 PDF 열기) ──
test("readFileForUpload: PDF 는 쪽마다 구획이 되고 조각 제목은 [파일명 · N쪽]", async () => {
  const source = { ...fakeSource({ pages: [longText("본문"), ""] }), destroyed: false, destroy() { this.destroyed = true; } };
  const file = new File(["%PDF-1.4 가짜"], "계획서.pdf", { lastModified: Date.UTC(2026, 10, 1) });
  const result = await readFileForUpload(file, { ocr: fakeOcr({}).ocr, openPdf: async () => source });
  assert.equal(result.kind, "pdf");
  assert.equal(result.totalPages, 2);
  assert.equal(result.ocrPages, 1);
  assert.deepEqual(result.messages.map((m) => m.text.split("\n")[0]), ["[계획서.pdf · 1쪽]", "[계획서.pdf · 2쪽]"]);
  assert.deepEqual(result.messages.map((m) => m.turnId.split(":").at(-1)), ["0", "1"]);
  assert.equal(source.destroyed, true);
});

test("readFileForUpload: 읽지 못한 쪽은 발화가 되지 않고 unread 로 돌려준다", async () => {
  const source = fakeSource({ pages: [longText("본문"), ""] });
  const file = new File(["%PDF"], "a.pdf");
  const result = await readFileForUpload(file, { ocr: fakeOcr({ 2: { ok: false, reason: "model_unavailable" } }).ocr, openPdf: async () => source });
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.unread, [{ page: 2, reason: "model_unavailable" }]);
});

test("readFileForUpload: 진행 상황을 읽는 중 → 글자 인식 중으로 알린다", async () => {
  const events = [];
  const file = new File(["%PDF"], "a.pdf");
  await readFileForUpload(file, { ocr: fakeOcr({}).ocr, openPdf: async () => fakeSource({ pages: ["", ""] }), onProgress: (p) => events.push(p) });
  assert.deepEqual(events[0], { phase: "reading" });
  assert.deepEqual(events.slice(1).map((e) => e.phase), ["ocr", "ocr", "ocr"]);
  assert.deepEqual(events.at(-1), { phase: "ocr", done: 2, total: 2 });
});
