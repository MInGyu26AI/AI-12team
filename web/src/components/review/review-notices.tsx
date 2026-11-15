"use client";

import type { RelatedCard } from "@shared/types";
import { buttonOutline, buttonPrimary, card, chip } from "@/components/ui/surface";
import type { useLocalCollector } from "@/lib/local-collector";
import { cn } from "@/lib/utils";

type Collector = ReturnType<typeof useLocalCollector>;

// 승인함 위쪽 알림: 수집기 연결 오류 · 승인 대상 팀 · 분류 실패 작업 · 옛 검토 후보 · 전송 대기 카드.
// 피그마 4번에 없는 기존 안내라 같은 흰 카드·칩 모양으로 맞춘다. 빨강은 실패에만 쓴다
export function ReviewNotices({ collector, queued }: { collector: Collector; queued: RelatedCard[] }) {
  const { status } = collector;
  return (
    <>
      {collector.error && (
        <p role="alert" className="text-sm text-destructive break-keep">
          {collector.error}
        </p>
      )}
      {status && (
        <p className="text-[13px] leading-[1.5] text-muted-foreground">
          승인 대상 · <strong className="font-medium text-foreground">{status.teamName}</strong> · {status.userName}
        </p>
      )}
      {(status?.failedJobs ?? []).map((job) => (
        <FailedJobAlert key={job.id} detail={job.detail} onRetry={() => collector.action("jobs.retry", { id: job.id })} />
      ))}
      {!!status?.legacyCandidates && (
        <p className="rounded-md bg-surface-soft px-3 py-2 text-[13px] text-muted-foreground break-keep">
          기존 검토 후보 {status.legacyCandidates}개는 수집기를 시작할 때 표시된 개인 검토함 주소에서 계속 검토할 수 있어요.
        </p>
      )}
      {queued.map((card) => (
        <QueuedCard key={card.id} card={card} onRetry={() => collector.action("delivery.retry", { id: card.id })} />
      ))}
    </>
  );
}

function FailedJobAlert({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return (
    <div role="alert" className={cn(card, "flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm")}>
      <p className="min-w-0 flex-1 text-destructive break-keep">{detail}</p>
      <button type="button" className={buttonOutline} onClick={onRetry}>
        분류 재시도
      </button>
    </div>
  );
}

// 승인은 저장됐고 팀 서버 전송을 기다리거나(pending), 전송이 거절돼 확인이 필요한(blocked) 카드
function QueuedCard({ card: c, onRetry }: { card: RelatedCard; onRetry: () => void }) {
  const blocked = c.deliveryState === "blocked";
  return (
    <article className={cn(card, "flex flex-wrap items-center gap-3 px-5 py-3.5")}>
      <strong className="min-w-0 flex-1 text-[15px] font-medium break-keep">{c.content}</strong>
      <span role="status" className={cn(chip, blocked ? "bg-alert-conflict-soft text-alert-conflict" : "bg-muted text-muted-foreground")}>
        {blocked ? "전송 확인 필요" : "승인 저장됨 · 전송 대기"}
      </span>
      {blocked && (
        <button type="button" className={buttonPrimary} onClick={onRetry}>
          승인한 내용 그대로 재시도
        </button>
      )}
    </article>
  );
}
