"use client";

// 싱크업 확장 프로그램(web-bridge 콘텐츠 스크립트)과 window.postMessage 로 연결.
// 확장이 없으면 available=false 로 남고, 화면은 붙여넣기/업로드만 보여준다.
import { useCallback, useEffect, useState } from "react";
import { BRIDGE_FROM_WEB, isExtToWeb, type ExtSettingsPatch, type ExtStatus, type WebToExt } from "@shared/bridge";
import type { RelatedCard } from "@shared/types";

interface BridgeState {
  available: boolean;
  checked: boolean; // 응답을 충분히 기다렸는지 (false 동안은 "확장 없음"으로 단정하지 않음)
  cards: RelatedCard[];
  userName: string | null;
  status: ExtStatus | null; // 확장 v0.2 부터
}

const WAIT_MS = 1200;

const send = (msg: WebToExt) => window.postMessage(msg, window.location.origin);

export function useExtensionBridge() {
  const [state, setState] = useState<BridgeState>({ available: false, checked: false, cards: [], userName: null, status: null });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin || !isExtToWeb(e.data)) return;
      setState({
        available: true,
        checked: true,
        cards: e.data.cards,
        userName: e.data.userName || null,
        status: e.data.status ?? null,
      });
    };
    window.addEventListener("message", onMessage);
    send({ source: BRIDGE_FROM_WEB, type: "hello" });
    const timer = setTimeout(() => setState((s) => ({ ...s, checked: true })), WAIT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, []);

  /** 승인·버린 카드를 확장의 검토 대기에서 지움 */
  const remove = useCallback((ids: string[], reason: "approved" | "dismissed") => {
    if (!ids.length) return;
    const drop = new Set(ids);
    setState((s) => ({ ...s, cards: s.cards.filter((c) => !drop.has(c.id)) })); // 화면은 바로 반영
    send({ source: BRIDGE_FROM_WEB, type: "remove", ids, reason });
  }, []);

  /** 대화 수집 화면·팀 만들기에서 확장 설정 바꾸기 */
  const updateSettings = useCallback((patch: ExtSettingsPatch) => {
    setState((s) => (s.status ? { ...s, status: { ...s.status, ...stripUndefined(patch) } } : s)); // 화면은 바로 반영
    send({ source: BRIDGE_FROM_WEB, type: "updateSettings", patch });
  }, []);

  const flush = useCallback(() => send({ source: BRIDGE_FROM_WEB, type: "flush" }), []);

  return { ...state, remove, updateSettings, flush };
}

const stripUndefined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
