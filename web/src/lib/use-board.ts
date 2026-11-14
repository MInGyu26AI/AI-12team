"use client";
// 팀 결정 기록: 보드 카드·처리 안 된 충돌·완료한 할 일을 읽고 POLL_MS 마다 다시 읽는다.
// 한 번 읽은 뒤의 실패는 마지막 화면(과 열린 충돌 창)을 두고 stale 로만 알린다. 늦게 온 옛 응답은 버린다
import { useCallback, useEffect, useRef, useState } from "react";
import type { Conflict, RelatedCard } from "@shared/types";
import { api, POLL_MS } from "./api";

export type BoardLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; cards: RelatedCard[]; conflicts: Conflict[]; done: Set<string>; stale?: boolean }; // stale = 마지막 새로고침 실패

/** 요청 순번: 나중에 보낸 요청의 응답이 이미 반영됐으면, 먼저 보낸 요청의 늦은 응답(성공·실패 모두)은 버린다 */
export function requestOrder() {
  let sent = 0;
  let applied = 0;
  return {
    next: () => ++sent,
    accept: (n: number) => (n > applied ? ((applied = n), true) : false),
  };
}

/** 새로고침 실패: 이미 보여 준 보드가 있으면 그대로 두고 stale 표시, 처음 읽기 실패면 오류 화면 */
export const afterFailure = (prev: BoardLoad, message: string): BoardLoad =>
  prev.state === "ready" ? { ...prev, stale: true } : { state: "error", message };

export function useBoard() {
  const [load, setLoad] = useState<BoardLoad>({ state: "loading" });
  const order = useRef(requestOrder());

  const refresh = useCallback(async () => {
    const mine = order.current.next();
    try {
      const [cards, conflicts, done] = await Promise.all([api.getBoard(), api.getConflicts(), api.getDoneTodos()]);
      if (order.current.accept(mine)) setLoad({ state: "ready", cards, conflicts, done: new Set(done) });
    } catch (e) {
      if (order.current.accept(mine)) setLoad((prev) => afterFailure(prev, (e as Error).message));
    }
  }, []);

  useEffect(() => {
    // 마운트 직후 불러오고 POLL_MS 마다 다시 읽는다
    void refresh();
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
