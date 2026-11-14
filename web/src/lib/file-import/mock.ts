// 목업(예시) 모드: 수집기가 없으니 읽은 조각을 이 브라우저의 규칙 분류기(shared/classify.ts mockClassify)가 읽는 발화로 바꾼다.
import { formatSource } from "@shared/format";
import type { Utterance } from "@shared/utterance";
import type { FileUploadMessage } from "./types";

/** 조각의 첫 줄(제목)은 출처 표시라 떼고, 본문을 사용자 발화로 */
export function toMockUtterances(fileName: string, messages: FileUploadMessage[], at = new Date()): Utterance[] {
  const source = formatSource(fileName, at);
  return messages.map((m) => {
    const newline = m.text.indexOf("\n");
    return {
      id: m.id,
      conversationId: m.conversationId,
      collectedAt: m.collectedAt,
      roleGuessed: false,
      speaker: "user" as const,
      text: newline >= 0 ? m.text.slice(newline + 1) : m.text,
      source,
    };
  });
}
