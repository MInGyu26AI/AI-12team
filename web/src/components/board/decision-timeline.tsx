"use client";

import Image from "next/image";
import { fmtHM, fmtMD, parseSource } from "@shared/format";
import { ALERT_LEVEL, type AlertLevel } from "@shared/labels";
import type { RelatedCard } from "@shared/types";
import { Avatar } from "@/components/avatar";
import { CheckProgress } from "@/components/board/conflict-checks";
import { card, chip } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

/** 새 결정(cardB)에 걸린 알림: 단계와 바뀌기 전 결정 내용 */
export interface Flag {
  level: AlertLevel;
  previous?: string;
}

// 왼쪽: 세부 주제 필터 (null = 전체). 피그마 182:67: 흰 카드 · 안쪽 13 · 항목 사이 4 · 고른 항목 베이지 면
export function TopicFilter({ topics, total, active, onChange }: {
  topics: { key: string; count: number }[];
  total: number;
  active: string | null;
  onChange: (topic: string | null) => void;
}) {
  return (
    <nav className={cn(card, "flex gap-1 overflow-x-auto p-2 lg:flex-col lg:p-[13px]")} aria-label="세부 주제">
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
        "flex shrink-0 items-center justify-between gap-4 rounded-md px-3 py-2 text-left text-sm leading-[1.5] font-medium whitespace-nowrap",
        active ? "bg-brand-soft" : "hover:bg-surface-soft",
      )}
    >
      {label}
      <span className="text-[13px]">{count}</span>
    </button>
  );
}

// 가운데: 결정 타임라인 (최신순). 피그마 182:83: 흰 카드 안에 결정 줄을 1px 선으로 나누고,
// 충돌·확인 필요·변경이 걸린 새 결정은 테두리 카드(모서리 10)로 띄운다. 단계 표시는 점 + 글자 (빨강은 충돌에만, 226:976)
export function DecisionTimeline({ decisions, flagged, saved, repoLinked, onOpenConflict }: {
  decisions: RelatedCard[];
  flagged: Map<string, Flag>; // 새 결정(cardB) id → 알림 단계 (충돌·확인 필요·변경)
  saved: Set<string>; // 레포에 반영된 결정 카드 id
  repoLinked: boolean; // 레포에 연결된 팀이면 줄마다 레포 반영 상태를 보인다
  onOpenConflict: () => void;
}) {
  return (
    <section className={cn(card, "p-[9px]")} aria-label="결정">
      {decisions.length ? (
        <ol className="divide-y divide-card-border">
          {decisions.map((c) => (
            <DecisionItem key={c.id} card={c} flag={flagged.get(c.id)} saved={saved.has(c.id)} repoLinked={repoLinked} onOpen={onOpenConflict} />
          ))}
        </ol>
      ) : (
        <p className="p-6 text-center text-sm text-muted-foreground">이 주제의 결정이 없어요.</p>
      )}
    </section>
  );
}

function DecisionItem({ card: c, flag, saved, repoLinked, onOpen }: {
  card: RelatedCard;
  flag?: Flag;
  saved: boolean;
  repoLinked: boolean;
  onOpen: () => void;
}) {
  const src = parseSource(c.source);
  const level = flag?.level;
  return (
    <li className={cn("flex gap-4 px-4 py-3.5", level && ALERT_LEVEL[level].card)}>
      <div className="w-12 shrink-0 leading-[1.5] sm:w-[90px]">
        {src.at && (
          <>
            <p className="text-[13px] font-medium">{fmtMD(src.at)}</p>
            <p className="text-xs text-muted-foreground">{fmtHM(src.at)}</p>
          </>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {c.topic_key && <span className={cn(chip, "bg-brand-soft text-muted-foreground")}>{c.topic_key}</span>}
          {level && <LevelLabel level={level} previous={flag?.previous} onOpen={onOpen} />}
        </div>
        <p className="text-base leading-[1.5] font-medium break-keep">{c.content}</p>
        {c.conflictCheckStatus === "complete" && <CheckProgress card={c} />}
        {c.reason && <p className="text-[13px] leading-[1.5] text-muted-foreground break-keep">이유: {c.reason}</p>}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="flex items-center gap-2 text-xs leading-[1.5] font-medium text-muted-foreground">
            <Avatar name={c.owner} size="sm" className="size-[22px] text-[11px]" />
            {[c.owner, src.label].filter(Boolean).join(" · ")}
          </p>
          {repoLinked && (saved || level) && (
            <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
              <Image src="/brand/github.svg" alt="" width={12} height={12} unoptimized className="opacity-60" />
              {saved ? "레포 반영" : "충돌 해결 후 레포에 저장"}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

// 단계 표시: 충돌 = 옅은 베이지 칩 + 빨강 점·글자, 확인 필요 = 노랑 점 + 황토 글자, 변경 = 파랑 점 + 글자 ('변경됨 · 이전: …')
function LevelLabel({ level, previous, onOpen }: { level: AlertLevel; previous?: string; onOpen: () => void }) {
  const tone = ALERT_LEVEL[level];
  const text = level === "change" ? (previous ? `변경됨 · 이전: ${previous}` : "변경됨") : tone.label;
  return (
    <button
      onClick={onOpen}
      className={cn(chip, "gap-1.5 hover:underline", tone.text, level === "conflict" ? tone.badge : "px-1")}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", tone.dot)} />
      <span className="max-w-[28ch] truncate">{text}</span>
    </button>
  );
}
