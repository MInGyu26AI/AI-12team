// '읽지 못한 쪽' 안내 문구 (순수 함수)
import type { UnreadPage, UnreadReason } from "./types";

export const UNREAD_REASON_LABEL: Record<UnreadReason, string> = {
  model_unavailable: "이 PC의 글자 인식 AI를 쓸 수 없어요 (Ollama 실행과 모델 설치를 확인해 주세요)",
  empty: "글자를 찾지 못했어요 (빈 쪽이거나 그림뿐이에요)",
  too_large: "쪽 그림이 너무 커서 보내지 못했어요",
  bad_image: "쪽 그림을 읽지 못했어요",
  ocr_off: "이 화면에서는 글자 인식을 쓸 수 없어요",
  render_failed: "쪽을 그림으로 만들지 못했어요",
  rpc_error: "수집기에서 답을 받지 못했어요",
};

/** [3,5,6,7] → "3, 5–7쪽" */
export function formatPageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return `${parts.join(", ")}쪽`;
}

export interface UnreadGroup {
  reason: UnreadReason;
  pages: string; // "3, 5–7쪽"
  count: number;
  label: string;
  detail?: string; // 수집기가 알려 준 오류 문구 (rpc_error)
}

/** 이유별로 묶는다. 이유의 첫 등장 순서를 지킨다 */
export function groupUnread(unread: UnreadPage[]): UnreadGroup[] {
  const groups = new Map<UnreadReason, { pages: number[]; detail?: string }>();
  for (const u of unread) {
    const group = groups.get(u.reason) ?? { pages: [] };
    group.pages.push(u.page);
    group.detail ??= u.detail;
    groups.set(u.reason, group);
  }
  return [...groups].map(([reason, g]) => ({
    reason,
    pages: formatPageList(g.pages),
    count: new Set(g.pages).size,
    label: UNREAD_REASON_LABEL[reason],
    ...(g.detail ? { detail: g.detail } : {}),
  }));
}
