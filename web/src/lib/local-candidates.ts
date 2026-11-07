"use client";

// 웹에서 붙여넣기·내보내기 업로드로 분류한 후보 (이 브라우저에만, 승인 전까지).
// 개인 내용은 개수만 남기고 문장은 저장하지 않는다.
import { useCallback } from "react";
import type { Card, RelatedCard } from "@shared/types";
import { useLocal } from "./local-store";

const KEY = "syncup:local-candidates:v1";

interface LocalCandidates {
  cards: RelatedCard[];
  personal: number;
  label: string; // "붙여넣은 대화" / "ChatGPT 내보내기 파일"
}

const EMPTY: LocalCandidates = { cards: [], personal: 0, label: "" };

export function useLocalCandidates() {
  const [value, set] = useLocal<LocalCandidates>(KEY, EMPTY);

  /** 새 분류 결과로 교체 */
  const replace = useCallback(
    (cards: Card[], label: string) =>
      set({
        cards: cards.filter((c): c is RelatedCard => c.relevance === "related"),
        personal: cards.filter((c) => c.relevance === "personal").length,
        label,
      }),
    [set],
  );

  const remove = useCallback(
    (ids: string[]) => {
      const drop = new Set(ids);
      const cards = value.cards.filter((c) => !drop.has(c.id));
      set(cards.length ? { ...value, cards } : EMPTY);
    },
    [set, value],
  );

  const edit = useCallback(
    (id: string, content: string) => set({ ...value, cards: value.cards.map((c) => (c.id === id ? { ...c, content } : c)) }),
    [set, value],
  );

  return { ...value, replace, remove, edit };
}
