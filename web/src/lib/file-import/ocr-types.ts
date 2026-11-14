// 글자 인식(files.ocr) 요청·응답 모양과 상수. 수집기에 닿는 코드(ocr.ts)와 나뉘어 있어 PDF 흐름을 수집기 없이 시험할 수 있다.
import type { UnreadReason } from "./types";

export interface OcrImage {
  page: number;
  image: string; // base64 PNG 또는 JPEG (디코드 8MB 이하)
}

export type OcrPageResult = { page: number; ok: true; text: string } | { page: number; ok: false; reason: UnreadReason; detail?: string };
export type OcrFn = (pages: OcrImage[]) => Promise<OcrPageResult[]>;

/** 한 번에 보내는 쪽 수 (수집기 응답을 기다리는 시간이 길어지지 않게 적게) */
export const OCR_PAGES_PER_CALL = 2;
/** 한 번에 보내는 그림의 base64 글자 수 합 상한. 로컬 웹 서버 중계(/api/local)의 요청 본문 한도 4MB 아래 */
export const OCR_MAX_CALL_CHARS = 3_000_000;
