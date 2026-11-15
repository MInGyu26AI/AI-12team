// 이 PC의 글자 인식(files.ocr, 수집기가 Ollama 비전 모델로 읽는다). 쪽 그림은 수집기 밖으로 나가지 않는다.
// 읽지 못한 쪽은 다른 곳으로 보내지 않고 '읽지 못한 쪽'으로 남긴다.
import { ExtensionMissing, rpc } from "@/lib/rpc";
import type { OcrFn, OcrPageResult } from "./ocr-types";
import type { UnreadReason } from "./types";

// 비전 모델은 쪽당 수십 초 걸릴 수 있다. 웹이 먼저 끊지 않도록 길게 (수집기·확장 쪽 한도가 더 짧으면 그쪽 오류가 먼저 온다)
const OCR_TIMEOUT_MS = 120_000;

const KNOWN_REASONS = new Set<string>(["model_unavailable", "empty", "too_large", "bad_image"]);

interface OcrResponse {
  model?: string;
  pages?: unknown;
}

/** 수집기 응답을 요청한 쪽마다 하나씩의 결과로 맞춘다. 빠졌거나 모양이 다르면 rpc_error */
export function matchOcrResults(requested: number[], response: OcrResponse | null | undefined): OcrPageResult[] {
  const items = Array.isArray(response?.pages) ? (response!.pages as Record<string, unknown>[]) : [];
  return requested.map((page): OcrPageResult => {
    const item = items.find((p) => p && p["page"] === page);
    if (!item) return { page, ok: false, reason: "rpc_error", detail: "응답에 이 쪽이 없어요" };
    if (item["ok"] === true && typeof item["text"] === "string") return { page, ok: true, text: item["text"] };
    if (item["ok"] === false && typeof item["reason"] === "string" && KNOWN_REASONS.has(item["reason"])) {
      return { page, ok: false, reason: item["reason"] as UnreadReason };
    }
    return { page, ok: false, reason: "rpc_error", detail: "알 수 없는 응답이에요" };
  });
}

/**
 * files.ocr 호출. 수집기에 닿지 못하거나 오류를 받으면 그 쪽들을 rpc_error 로 돌려준다 (파일 전체를 멈추지 않는다).
 * 확장이 없으면 어차피 보낼 수도 없으므로 그대로 던진다.
 */
export function createOcr(fileName: string, call: typeof rpc = rpc): OcrFn {
  return async (pages) => {
    try {
      const response = await call<OcrResponse>("files.ocr", { name: fileName, pages }, OCR_TIMEOUT_MS);
      return matchOcrResults(
        pages.map((p) => p.page),
        response,
      );
    } catch (error) {
      if (error instanceof ExtensionMissing) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      return pages.map((p): OcrPageResult => ({ page: p.page, ok: false, reason: "rpc_error", detail }));
    }
  };
}
