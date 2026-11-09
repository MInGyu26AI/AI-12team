"use client";
// 팀 결정 기록: 보드 카드·처리 안 된 충돌·완료한 할 일을 읽고 POLL_MS 마다 다시 읽는다
import { useCallback, useEffect, useState } from "react";
import type { Conflict, RelatedCard } from "@shared/types";
import { api, POLL_MS } from "./api";

export type BoardLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; cards: RelatedCard[]; conflicts: Conflict[]; done: Set<string> };

export function useBoard() {
  const [load, setLoad] = useState<BoardLoad>({ state: "loading" });

  const refresh = useCallback(async () => {
    try {
      const [cards, conflicts, done] = await Promise.all([api.getBoard(), api.getConflicts(), api.getDoneTodos()]);
      setLoad({ state: "ready", cards, conflicts, done: new Set(done) });
    } catch (e) {
      setLoad({ state: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 마운트 직후 불러오고 POLL_MS 마다 다시 읽는다
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // 불러오는 중 화면으로 돌아가 처음부터 다시 읽는다 (오류 재시도·목업 초기화)
  const reload = () => {
    setLoad({ state: "loading" });
    void refresh();
  };

  return { load, refresh, reload };
}
