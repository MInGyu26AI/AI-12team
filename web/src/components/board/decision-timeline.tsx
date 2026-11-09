"use client";

import { fmtHM, fmtMD, parseSource } from "@shared/format";
import { JUDGEMENT_COLOR } from "@shared/labels";
import type { Judgement, RelatedCard } from "@shared/types";
import { Avatar } from "@/components/avatar";
import { CheckProgress } from "@/components/board/conflict-checks";
import { cn } from "@/lib/utils";

// 왼쪽: 세부 주제 필터 (null = 전체)
export function TopicFilter({ topics, total, active, onChange }: {
  topics: { key: string; count: number }[];
  total: number;
  active: string | null;
  onChange: (topic: string | null) => void;
}) {
  return (
    <nav className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-2 lg:flex-col lg:p-3" aria-label="세부 주제">
      <TopicButton label="전체" count={total} active={!active} onClick={() => onChange(null)} />
      {topics.map((t) => (
        <TopicButton key={t.key} label={t.key} count={t.count} active={active === t.key} onClick={() => onChange(t.key)} />
      ))}
    </nav>
  );
}

function TopicButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center justify-between gap-4 rounded-lg px-3.5 py-2.5 text-left whitespace-nowrap",
        active ? "bg-brand-soft font-semibold text-brand" : "hover:bg-muted",
      )}
    >
      {label}
      <span className={cn("text-sm", active ? "text-brand" : "text-muted-foreground")}>{count}</span>
    </button>
  );
}

// 가운데: 결정 타임라인 (최신순). 충돌·변경 판정이 걸린 새 결정은 빨간 테두리, 배지를 누르면 충돌 모달
export function DecisionTimeline({ decisions, flagged, onOpenConflict }: {
  decisions: RelatedCard[];
  flagged: Map<string, Judgement>; // 새 결정(cardB) id → 판정
  onOpenConflict: () => void;
}) {
  return (
    <section className="rounded-xl border bg-card p-2" aria-label="결정">
      {decisions.length ? (
        <ol className="divide-y">
          {decisions.map((c) => (
            <DecisionItem key={c.id} card={c} judgement={flagged.get(c.id)} onOpen={onOpenConflict} />
          ))}
        </ol>
      ) : (
        <p className="p-6 text-center text-sm text-muted-foreground">이 주제의 결정이 없어요.</p>
      )}
    </section>
  );
}

function DecisionItem({ card: c, judgement, onOpen }: { card: RelatedCard; judgement?: Judgement; onOpen: () => void }) {
  const src = parseSource(c.source);
  return (
    <li
      className={cn(
        "grid grid-cols-[52px_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl p-4 sm:grid-cols-[72px_minmax(0,1fr)] sm:p-5",
        judgement && "border border-sensitive/50 bg-sensitive-soft/40",
      )}
    >
      <div className="text-sm">
        {src.at ? (
          <>
            <p className="font-semibold">{fmtMD(src.at)}</p>
            <p className="text-muted-foreground">{fmtHM(src.at)}</p>
          </>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {c.topic_key && <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">{c.topic_key}</span>}
          {judgement && (
            <button onClick={onOpen} className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", JUDGEMENT_COLOR[judgement])}>
              {judgement}
            </button>
          )}
        </div>
        <p className="text-lg font-bold break-keep">{c.content}</p>
        {c.conflictCheckStatus === "complete" && <CheckProgress card={c} />}
        {c.reason && <p className="text-sm text-muted-foreground break-keep">이유: {c.reason}</p>}
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Avatar name={c.owner} size="sm" />
          {[c.owner, src.label].filter(Boolean).join(" · ")}
        </p>
      </div>
    </li>
  );
}
