"use client";
// 승인함 화면 상태: 후보 모으기·수정·버리기(useReviewCandidates)와 체크 상태(useReviewSelection)
import { useEffect, useRef, useState } from "react";
import type { RelatedCard } from "@shared/types";
import { boardTopicKeys, USE_MOCK } from "./api";
import { useLocalCandidates } from "./local-candidates";
import { useLocalCollector } from "./local-collector";
import { isChecked, mergeCandidates, selectionOf, type Overrides } from "./review-candidates";

// 팀 보드의 세부 주제 (화면을 열 때 한 번 읽는다)
function useBoardTopicKeys() {
  const [keys, setKeys] = useState<Set<string> | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    boardTopicKeys()
      .then(setKeys)
      .catch(() => {});
  }, []);
  return keys;
}

export function useReviewCandidates() {
  const collector = useLocalCollector();
  const local = useLocalCandidates();
  const boardKeys = useBoardTopicKeys();
  const pasted = USE_MOCK ? local : null;
  const collectedIds = new Set(collector.cards.map((c) => c.id));
  const fromCollector = (id: string) => collectedIds.has(id);

  const editContent = async (id: string, content: string) => {
    if (fromCollector(id)) await collector.action("candidates.update", { id, patch: { content } });
    else local.edit(id, content);
  };

  const drop = (ids: string[], reason: "approved" | "dismissed") => {
    void collector.remove(ids.filter(fromCollector), reason);
    if (pasted) local.remove(ids.filter((id) => !fromCollector(id)));
  };

  return {
    collector,
    ...mergeCandidates(collector.cards, pasted, boardKeys),
    pastedCount: pasted?.cards.length ?? 0,
    pastedLabel: local.label,
    fromCollector,
    editContent,
    drop,
  };
}

export function useReviewSelection(shareable: RelatedCard[]) {
  const [overrides, setOverrides] = useState<Overrides>({});
  const { selectable, selected, allSelected, toggledAll } = selectionOf(shareable, overrides);
  return {
    canSelect: selectable.length > 0,
    selected,
    allSelected,
    isChecked: (c: RelatedCard) => isChecked(c, overrides),
    setChecked: (id: string, on: boolean) => setOverrides((p) => ({ ...p, [id]: on })),
    toggleAll: () => setOverrides(toggledAll),
    clear: () => setOverrides({}),
  };
}
