// 파일 하나를 읽어 수집기에 보낼 발화로 만든다 (이 브라우저 안에서만; 글자 인식 요청만 이 PC의 수집기로 간다)
import { decodeText } from "./decode";
import { detectKind, MAX_FILE_BYTES } from "./detect";
import { parseDocx } from "./docx";
import { parseHwpx } from "./hwpx";
import { parseMarkdown, parsePlainText } from "./markdown";
import { buildMessages, isoWithOffset, sourceIdOf, MAX_CHUNKS_PER_FILE } from "./messages";
import type { OcrFn } from "./ocr-types";
import { parsePdfPages, type PdfSource } from "./pdf";
import { parseXlsx } from "./xlsx";
import { FileImportError, type FileKind, type FileUploadMessage, type ParsedSection, type ParseResult, type UnreadPage } from "./types";

export type ReadProgress = { phase: "reading" } | { phase: "ocr"; done: number; total: number };

export interface ReadDeps {
  ocr: OcrFn | null; // null = 글자 인식을 쓰지 않는다 (글자가 없는 쪽은 읽지 못한 쪽으로 남는다)
  onProgress?: (p: ReadProgress) => void;
  /** 시험용: pdf.js 대신 쓸 PDF 열기 */
  openPdf?: (bytes: Uint8Array) => Promise<PdfSource & { destroy?: () => Promise<void> | void }>;
  maxChunks?: number;
}

export interface FileReadResult {
  fileName: string;
  kind: FileKind;
  sourceId: string;
  sections: ParsedSection[];
  messages: FileUploadMessage[];
  warnings: string[];
  unread: UnreadPage[];
  totalPages: number | null; // PDF 만
  ocrPages: number; // 글자 인식으로 읽은 쪽 수
}

async function openPdfDefault(bytes: Uint8Array) {
  return (await import("./pdf-js")).openPdfJs(bytes);
}

export async function readFileForUpload(file: File, deps: ReadDeps): Promise<FileReadResult> {
  const kind = detectKind(file.name);
  if (file.size === 0) throw new FileImportError("빈 파일이에요.");
  if (file.size > MAX_FILE_BYTES) throw new FileImportError(`${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 이하 파일을 올려 주세요.`);
  deps.onProgress?.({ phase: "reading" });
  const buffer = await file.arrayBuffer();
  const sourceId = await sourceIdOf(buffer);

  let parsed: ParseResult;
  let unread: UnreadPage[] = [];
  let totalPages: number | null = null;
  let ocrPages = 0;
  switch (kind) {
    case "markdown":
      parsed = parseMarkdown(decodeText(new Uint8Array(buffer)), file.name);
      break;
    case "text":
      parsed = parsePlainText(decodeText(new Uint8Array(buffer)), file.name);
      break;
    case "docx":
      parsed = await parseDocx(buffer, file.name);
      break;
    case "xlsx":
      parsed = await parseXlsx(buffer, file.name);
      break;
    case "hwpx":
      parsed = await parseHwpx(buffer, file.name);
      break;
    case "pdf": {
      const source = await (deps.openPdf ?? openPdfDefault)(new Uint8Array(buffer));
      try {
        const pdf = await parsePdfPages(source, {
          fileName: file.name,
          ocr: deps.ocr,
          onProgress: (p) => deps.onProgress?.({ phase: "ocr", ...p }),
        });
        parsed = pdf;
        unread = pdf.unread;
        totalPages = pdf.totalPages;
        ocrPages = pdf.ocrPages;
      } finally {
        await source.destroy?.();
      }
      break;
    }
  }

  const { messages, truncated } = await buildMessages({
    sourceId,
    sections: parsed.sections,
    collectedAt: isoWithOffset(file.lastModified),
    maxChunks: deps.maxChunks,
  });
  const warnings = [...parsed.warnings];
  if (truncated) warnings.push(`내용이 많아 앞쪽 ${deps.maxChunks ?? MAX_CHUNKS_PER_FILE}조각까지만 올려요.`);
  return { fileName: file.name, kind, sourceId, sections: parsed.sections, messages, warnings, unread, totalPages, ocrPages };
}
