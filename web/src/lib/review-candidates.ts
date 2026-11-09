// 승인함에 보일 후보를 모으고(수집기 후보 + 목업 붙여넣기 후보) 체크 상태를 계산한다. 화면 상태가 없는 순수 함수만 둔다.
import { LOW_CONFIDENCE, isShareable } from "@shared/labels";
import type { RelatedCard } from "@shared/types";
import type { LocalCandidates } from "./local-candidates";

const ORDER = { decision: 0, research: 1, todo: 2, none: 3 } as const;

/**
 * pasted = 이 브라우저에서 붙여넣기로 분류한 후보. 목업 모드만 넘긴다(실제 모드의 붙여넣기는 수집기 후보로 들어온다).
 * boardKeys = 팀 보드의 세부 주제. 수집기는 팀 보드를 모르므로 "새 주제" 여부를 이것으로 다시 판단한다.
 */
export function mergeCandidates(collected: RelatedCard[], pasted: LocalCandidates | null, boardKeys: Set<string> | null) {
  const fromCollector = collected.map((c) => ({
    ...c,
    is_new_topic: boardKeys && c.topic_key ? !boardKeys.has(c.topic_key) : c.is_new_topic,
  }));
  const all = [...fromCollector, ...(pasted?.cards ?? [])].sort((a, b) => ORDER[a.tag] - ORDER[b.tag]);
  return {
    total: all.length,
    shareable: all.filter(isShareable).filter((c) => !c.deliveryState),
    queued: all.filter((c) => c.deliveryState), // 승인 저장됨 · 전송 대기 또는 확인 필요
    others: all.filter((c) => c.tag === "none"), // 공유 후보 아님 (요청·제안·AI 답변)
    // 개인 내용 수. 목업 붙여넣기만 센다 (실제 모드는 개인 내용을 수집기가 '제외됨' 탭으로 보여 준다)
    personal: pasted?.personal ?? 0,
  };
}

// 사용자가 체크를 바꾼 카드만 담는다. 나머지는 확신도 LOW_CONFIDENCE 이상이면 기본 체크
export type Overrides = Record<string, boolean>;

// 화자를 추정한 카드는 사용자가 화자를 확인하기 전까지 고를 수 없다 (candidate-card 의 체크박스도 막힘)
export const isSelectable = (c: RelatedCard) => !c.evidence?.roleGuessed;

export const isChecked = (c: RelatedCard, overrides: Overrides) =>
  isSelectable(c) && (overrides[c.id] ?? c.confidence >= LOW_CONFIDENCE);

/** '전체 선택'·'전체 해제'는 고를 수 있는 카드만 센다 */
export function selectionOf(shareable: RelatedCard[], overrides: Overrides) {
  const selectable = shareable.filter(isSelectable);
  const selected = selectable.filter((c) => isChecked(c, overrides));
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  const toggledAll: Overrides = Object.fromEntries(selectable.map((c) => [c.id, !allSelected]));
  return { selectable, selected, allSelected, toggledAll };
}
