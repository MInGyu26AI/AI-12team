"use client";

import { fmtHM, fmtMD, parseSource } from "@shared/format";
import { ALERT_LEVEL, type AlertLevel } from "@shared/labels";
import type { RelatedCard } from "@shared/types";
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

// 가운데: 결정 타임라인 (최신순). 충돌·확인 필요·변경이 걸린 새 결정은 단계 색 테두리, 배지를 누르면 충돌 모달.
// 레포의 syncup.json 에 들어간 결정은 "레포 반영 ✓"
export function DecisionTimeline({ decisions, flagged, saved, onOpenConflict }: {
  decisions: RelatedCard[];
  flagged: Map<string, AlertLevel>; // 새 결정(cardB) id → 알림 단계 (충돌·확인 필요·변경)
  saved: Set<string>; // 레포에 반영된 결정 카드 id
  onOpenConflict: () => void;
}) {
  return (
    <section className="rounded-xl border bg-card p-2" aria-label="결정">
      {decisions.length ? (
        <ol className="divide-y">
          {decisions.map((c) => (
            <DecisionItem key={c.id} card={c} level={flagged.get(c.id)} saved={saved.has(c.id)} onOpen={onOpenConflict} />
          ))}
        </ol>
      ) : (
        <p className="p-6 text-center text-sm text-muted-foreground">이 주제의 결정이 없어요.</p>
      )}
    </section>
  );
}

function DecisionItem({ card: c, level, saved, onOpen }: { card: RelatedCard; level?: AlertLevel; saved: boolean; onOpen: () => void }) {
  const src = parseSource(c.source);
  return (
    <li
      className={cn(
        "grid grid-cols-[52px_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl p-4 sm:grid-cols-[72px_minmax(0,1fr)] sm:p-5",
        level && ALERT_LEVEL[level].card,
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
          {level && (
            <button onClick={onOpen} className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", ALERT_LEVEL[level].badge)}>
              {ALERT_LEVEL[level].label}
            </button>
          )}
          {saved && <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-semibold text-ok">레포 반영 ✓</span>}
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
