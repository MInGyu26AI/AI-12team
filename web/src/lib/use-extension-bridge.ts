"use client";

// 싱크업 확장 프로그램(web-bridge 콘텐츠 스크립트)과 window.postMessage 로 연결.
// 확장이 없으면 available=false 로 남고, 화면은 붙여넣기/업로드만 보여준다.
import { useCallback, useEffect, useState } from "react";
import { BRIDGE_FROM_WEB, isExtToWeb, type WebToExt } from "@shared/bridge";
import type { RelatedCard } from "@shared/types";

interface BridgeState {
  available: boolean;
  cards: RelatedCard[];
  userName: string | null;
}

export function useExtensionBridge() {
  const [state, setState] = useState<BridgeState>({ available: false, cards: [], userName: null });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin || !isExtToWeb(e.data)) return;
      setState({ available: true, cards: e.data.cards, userName: e.data.userName || null });
    };
    window.addEventListener("message", onMessage);
    const hello: WebToExt = { source: BRIDGE_FROM_WEB, type: "hello" };
    window.postMessage(hello, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** 승인·버린 카드를 확장의 검토 대기에서 지움 */
  const remove = useCallback((ids: string[], reason: "approved" | "dismissed") => {
    if (!ids.length) return;
    const drop = new Set(ids);
    setState((s) => ({ ...s, cards: s.cards.filter((c) => !drop.has(c.id)) })); // 화면은 바로 반영
    const msg: WebToExt = { source: BRIDGE_FROM_WEB, type: "remove", ids, reason };
    window.postMessage(msg, window.location.origin);
  }, []);

  return { ...state, remove };
}
