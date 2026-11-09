"use client";

import type { RelatedCard } from "@shared/types";
import { Button } from "@/components/ui/button";
import type { useLocalCollector } from "@/lib/local-collector";

type Collector = ReturnType<typeof useLocalCollector>;

// 승인함 위쪽 알림: 수집기 연결 오류 · 승인 대상 팀 · 분류 실패 작업 · 옛 검토 후보 · 전송 대기 카드
export function ReviewNotices({ collector, queued }: { collector: Collector; queued: RelatedCard[] }) {
  const { status } = collector;
  return (
    <>
      {collector.error && <p role="alert">{collector.error}</p>}
      {status && (
        <p>
          승인 대상 · <strong>{status.teamName}</strong> · {status.userName}
        </p>
      )}
      {(status?.failedJobs ?? []).map((job) => (
        <FailedJobAlert key={job.id} detail={job.detail} onRetry={() => collector.action("jobs.retry", { id: job.id })} />
      ))}
      {!!status?.legacyCandidates && (
        <p>기존 검토 후보 {status.legacyCandidates}개는 수집기를 시작할 때 표시된 개인 검토함 주소에서 계속 검토할 수 있어요.</p>
      )}
      {queued.map((card) => (
        <QueuedCard key={card.id} card={card} onRetry={() => collector.action("delivery.retry", { id: card.id })} />
      ))}
    </>
  );
}

function FailedJobAlert({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border p-4">
      {detail}{" "}
      <Button variant="outline" onClick={onRetry}>
        분류 재시도
      </Button>
    </div>
  );
}

// 승인은 저장됐고 팀 서버 전송을 기다리거나(pending), 전송이 거절돼 확인이 필요한(blocked) 카드
function QueuedCard({ card, onRetry }: { card: RelatedCard; onRetry: () => void }) {
  const blocked = card.deliveryState === "blocked";
  return (
    <article className="rounded-xl border p-5">
      <strong>{card.content}</strong>
      <p role="status">{blocked ? "전송 확인 필요" : "승인 저장됨 · 전송 대기"}</p>
      {blocked && <Button onClick={onRetry}>승인한 내용 그대로 재시도</Button>}
    </article>
  );
}
