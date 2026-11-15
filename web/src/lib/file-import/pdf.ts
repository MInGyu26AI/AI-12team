// PDF: 쪽마다 글자를 먼저 읽고, 글자가 거의 없는 쪽(스캔·그림)만 이 PC의 글자 인식(files.ocr)으로 읽는다.
// pdf.js 에 기대는 부분은 pdf-js.ts(브라우저 전용). 여기는 pdf.js 없이 시험할 수 있는 순수 흐름이다.
import { fileHeading } from "./sections";
import { nonSpaceLength, normalizeText } from "./text";
import { OCR_MAX_CALL_CHARS, OCR_PAGES_PER_CALL, type OcrFn, type OcrImage, type OcrPageResult } from "./ocr-types";
import type { ParsedSection, PdfParseResult, UnreadPage } from "./types";

/** 한 파일에서 읽는 쪽 수 상한 */
export const MAX_PDF_PAGES = 50;
/** 공백을 뺀 글자가 이보다 적은 쪽은 글자 인식으로 읽는다 */
export const MIN_PAGE_TEXT_CHARS = 20;

export interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

/** pdf.js 의 글자 조각들 → 줄바꿈과 띄어쓰기를 살린 글. 줄이 바뀌면(세로 위치 차) 줄바꿈, 가로로 떨어졌으면 공백 */
export function joinTextItems(items: PdfTextItem[]): string {
  let out = "";
  let lastY: number | null = null;
  let lastEnd = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue; // 표시용 마커
    const [, , , d, x, y] = item.transform ?? [];
    const height = item.height || Math.abs(d ?? 0) || 10;
    if (item.str === "") {
      if (item.hasEOL && out && !out.endsWith("\n")) out += "\n";
      continue;
    }
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > height * 0.6) {
      if (!out.endsWith("\n")) out += "\n";
    } else if (out && !out.endsWith("\n") && x !== undefined && x - lastEnd > height * 0.15 && !/\s$/.test(out) && !/^\s/.test(item.str)) {
      out += " ";
    }
    out += item.str;
    if (y !== undefined) lastY = y;
    lastEnd = (x ?? 0) + (item.width ?? 0);
    if (item.hasEOL) out += "\n";
  }
  return out;
}

/** 쪽 글자 정리: 줄 안의 연속 공백을 하나로, 나머지는 normalizeText */
export const cleanPageText = (text: string) => normalizeText(text.replace(/[ \t]{2,}/g, " "));

export interface PdfSource {
  numPages: number;
  getText(page: number): Promise<string>;
  /** 쪽을 그림(base64)으로. too_large 는 그림이 한 번에 보낼 수 있는 크기를 넘음 */
  renderPage(page: number): Promise<{ ok: true; image: string } | { ok: false; reason: "render_failed" | "too_large" }>;
}

export interface PdfParseOptions {
  fileName: string;
  ocr: OcrFn | null; // null = 글자 인식을 쓸 수 없음 (목업 모드 등)
  onProgress?: (p: { done: number; total: number }) => void; // 글자 인식 진행 (쪽 수)
  maxPages?: number;
  pagesPerCall?: number;
  maxCallChars?: number;
  minTextChars?: number;
}

export async function parsePdfPages(source: PdfSource, opts: PdfParseOptions): Promise<PdfParseResult> {
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const perCall = opts.pagesPerCall ?? OCR_PAGES_PER_CALL;
  const maxChars = opts.maxCallChars ?? OCR_MAX_CALL_CHARS;
  const minText = opts.minTextChars ?? MIN_PAGE_TEXT_CHARS;
  const pageCount = Math.min(source.numPages, maxPages);
  const warnings: string[] = [];
  if (source.numPages > maxPages) warnings.push(`앞쪽 ${maxPages}쪽까지만 읽었어요 (전체 ${source.numPages}쪽).`);

  const texts = new Map<number, string>();
  const needOcr: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    let text = "";
    try {
      text = cleanPageText(await source.getText(page));
    } catch {
      // 글자를 못 읽은 쪽은 글자가 없는 쪽과 같게 본다
    }
    if (nonSpaceLength(text) >= minText) texts.set(page, text);
    else needOcr.push(page);
  }

  const unread: UnreadPage[] = [];
  let ocrPages = 0;
  if (needOcr.length && !opts.ocr) {
    unread.push(...needOcr.map((page): UnreadPage => ({ page, reason: "ocr_off" })));
  } else if (needOcr.length && opts.ocr) {
    const ocr = opts.ocr;
    let done = 0;
    const state = { modelDown: false }; // 한 번 꺼져 있다고 답하면 남은 쪽은 요청하지 않는다
    const report = () => opts.onProgress?.({ done, total: needOcr.length });
    report();

    const record = (result: OcrPageResult) => {
      if (result.ok) {
        const text = cleanPageText(result.text);
        if (nonSpaceLength(text) > 0) {
          texts.set(result.page, text);
          ocrPages += 1;
          return;
        }
        unread.push({ page: result.page, reason: "empty" });
        return;
      }
      if (result.reason === "model_unavailable") state.modelDown = true;
      unread.push({ page: result.page, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) });
    };

    // 여러 쪽 요청이 통째로 실패하면 쪽마다 따로 다시 보낸다 (한 번에 너무 오래 걸렸을 수 있다)
    const send = async (batch: OcrImage[]): Promise<OcrPageResult[]> => {
      const results = await ocr(batch);
      if (batch.length > 1 && results.every((r) => !r.ok && r.reason === "rpc_error")) {
        const singles: OcrPageResult[] = [];
        for (const image of batch) singles.push(...(await ocr([image])));
        return singles;
      }
      return results;
    };

    let batch: OcrImage[] = [];
    let batchChars = 0;
    const flush = async () => {
      if (!batch.length) return;
      const sending = batch;
      batch = [];
      batchChars = 0;
      for (const result of await send(sending)) record(result);
      done += sending.length;
      report();
    };

    for (const page of needOcr) {
      if (state.modelDown) {
        unread.push({ page, reason: "model_unavailable" });
        done += 1;
        continue;
      }
      const rendered = await source.renderPage(page).catch(() => ({ ok: false as const, reason: "render_failed" as const }));
      if (!rendered.ok) {
        unread.push({ page, reason: rendered.reason });
        done += 1;
        report();
        continue;
      }
      if (batch.length && (batch.length >= perCall || batchChars + rendered.image.length > maxChars)) await flush();
      if (state.modelDown) {
        // 방금 보낸 묶음이 모델이 꺼져 있다고 답했다
        unread.push({ page, reason: "model_unavailable" });
        done += 1;
        continue;
      }
      batch.push({ page, image: rendered.image });
      batchChars += rendered.image.length;
    }
    await flush();
    report();
  }

  const sections: ParsedSection[] = [...texts]
    .sort(([a], [b]) => a - b)
    .map(([page, text]) => ({ heading: fileHeading(opts.fileName, `${page}쪽`), text, index: page - 1 }));
  unread.sort((a, b) => a.page - b.page);
  if (!sections.length && !unread.length) warnings.push("읽을 수 있는 글이 없어요.");
  return { sections, warnings, unread, totalPages: source.numPages, ocrPages };
}
