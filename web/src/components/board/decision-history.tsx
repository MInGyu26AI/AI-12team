"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { DECISION_STATE_LABEL, RESOLUTION_LABEL } from "@shared/labels";
import { card } from "@/components/ui/surface";
import { api, type DecisionHistory } from "@/lib/api";
import { cn } from "@/lib/utils";

// 충돌 처리로 내려간 결정과 처리 이력. 펼칠 때마다 새로 읽는다.
// 피그마 6번에 없는 기존 기능이라 결정 타임라인 아래에 접어 둔다 (사용자 결정 11/15)
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
  const empty = history && !lowered.length && !history.events.length;

  return (
    <details className={cn(card, "group px-5 py-3.5")} onToggle={(e) => e.currentTarget.open && void load()}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        이전 결정과 처리 이력
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <ul className="mt-3 space-y-2 border-t border-card-border pt-3 text-[13px] leading-[1.5]">
        {lowered.map((c) => (
          <li key={c.id} className="break-keep">
            {c.content} <span className="text-text-tertiary">· {c.label}</span>
          </li>
        ))}
        {history?.events.map((e, i) => (
          <li key={i} className="break-keep">
            <span className="text-text-tertiary">{e.at}</span> · {RESOLUTION_LABEL[e.resolution]} {e.note}
          </li>
        ))}
        {empty && <li className="text-muted-foreground">아직 처리한 충돌이 없어요.</li>}
      </ul>
    </details>
  );
}
