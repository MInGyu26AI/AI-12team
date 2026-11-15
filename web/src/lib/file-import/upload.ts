// 파일 하나를 올리는 한 번의 흐름: 읽기 → (글자 인식) → 수집기로 보내기. 화면은 진행(onPhase)과 결과만 다룬다.
// 목업 모드는 보내지 않고 읽기까지만 한다 (분류는 화면이 이 브라우저에서 한다).
import type { IntakeSummary } from "@/lib/collector-intake";
import { readFileForUpload, type FileReadResult, type ReadDeps, type ReadProgress } from "./import-file";
import type { OcrFn } from "./ocr-types";
import { fileIntakeNotice } from "./send";
import type { FileUploadMessage } from "./types";

export type UploadPhase = ReadProgress | { phase: "sending"; done: number; total: number };

export interface UploadDeps {
  mock: boolean;
  ocr: OcrFn | null;
  send: (messages: FileUploadMessage[], onProgress: (done: number, total: number) => void) => Promise<IntakeSummary>;
  onPhase?: (phase: UploadPhase) => void;
  openPdf?: ReadDeps["openPdf"]; // 시험용: pdf.js 대신 쓸 PDF 열기
}

export interface UploadOutcome {
  read: FileReadResult;
  tone: "success" | "warning";
  text: string;
  summary: IntakeSummary | null; // 수집기가 알려 준 개수 (목업·보낼 게 없으면 null)
}

export async function uploadFile(file: File, deps: UploadDeps): Promise<UploadOutcome> {
  const read = await readFileForUpload(file, { ocr: deps.ocr, onProgress: deps.onPhase, openPdf: deps.openPdf });
  const unreadNote = read.unread.length ? ` 읽지 못한 ${new Set(read.unread.map((u) => u.page)).size}쪽은 올리지 않았어요.` : "";
  if (!read.messages.length) {
    return { read, tone: "warning", text: `올릴 수 있는 내용이 없어요.${unreadNote}`, summary: null };
  }
  if (deps.mock) {
    return { read, tone: read.unread.length ? "warning" : "success", text: `${read.messages.length}조각을 읽었어요.${unreadNote}`, summary: null };
  }
  deps.onPhase?.({ phase: "sending", done: 0, total: read.messages.length });
  const summary = await deps.send(read.messages, (done, total) => deps.onPhase?.({ phase: "sending", done, total }));
  const notice = fileIntakeNotice(summary);
  return { read, tone: read.unread.length ? "warning" : notice.tone, text: `${notice.text}${unreadNote}`, summary };
}
