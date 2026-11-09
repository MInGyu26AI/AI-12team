"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DECISION_STATE_LABEL, RESOLUTION_LABEL } from "@shared/labels";
import { api, type DecisionHistory } from "@/lib/api";

// 충돌 처리로 내려간 결정과 처리 이력. 펼칠 때마다 새로 읽는다
export function DecisionHistoryList() {
  const [history, setHistory] = useState<DecisionHistory | null>(null);

  const load = async () => {
    try {
      setHistory(await api.getHistory());
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const lowered = (history?.records ?? []).flatMap((c) => {
    const label = c.decisionState && DECISION_STATE_LABEL[c.decisionState];
    return label ? [{ id: c.id, content: c.content, label }] : [];
  });

  return (
    <details className="rounded-xl border p-4" onToggle={(e) => e.currentTarget.open && void load()}>
      <summary className="cursor-pointer">이전 결정과 처리 이력</summary>
      <ul className="mt-3 space-y-2">
        {lowered.map((c) => (
          <li key={c.id}>
            {c.content} · {c.label}
          </li>
        ))}
        {history?.events.map((e, i) => (
          <li key={i}>
            {e.at} · {RESOLUTION_LABEL[e.resolution]} {e.note}
          </li>
        ))}
      </ul>
    </details>
  );
}
