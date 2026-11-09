"use client";

import type { RelatedCard } from "@shared/types";
import { Button } from "@/components/ui/button";

const UNFINISHED = ["pending", "running", "failed"];

// 팀 서버의 충돌 검사가 아직 끝나지 않은 카드. 실패한 검사는 남은 비교를 다시 시작할 수 있다
export function ConflictChecks({ cards, onRetry }: { cards: RelatedCard[]; onRetry: (id: string) => void }) {
  return (
    <>
      {cards
        .filter((c) => UNFINISHED.includes(c.conflictCheckStatus ?? ""))
        .map((c) => (
          <div key={c.id} className="space-y-2 rounded border p-3">
            <p>
              {c.content} · {c.conflictCheckDetail || "기존 결정과 비교 중"}
            </p>
            <CheckProgress card={c} />
            <p className="text-sm text-muted-foreground">아직 전체 검사가 끝나지 않았어요. 발견된 충돌은 먼저 표시합니다.</p>
            {c.conflictCheckStatus === "failed" && (
              <Button variant="outline" onClick={() => onRetry(c.id)}>
                남은 검사 재시도
              </Button>
            )}
          </div>
        ))}
    </>
  );
}

export function CheckProgress({ card }: { card: RelatedCard }) {
  const progress = card.conflictCheckProgress;
  const complete = card.conflictCheckStatus === "complete";
  if (!progress) return <p className="text-sm text-muted-foreground">{complete ? "검사 완료" : "비교 대상 확인 대기"}</p>;
  return (
    <div className="space-y-1 text-sm text-muted-foreground" role="status">
      <p>
        {complete ? "검사 완료" : "검사 진행"} · {progress.completed}/{progress.total}개 비교 완료
        {progress.skipped > 0 && ` · 비활성 결정 ${progress.skipped}개 제외`}
      </p>
      {!complete && progress.total > 0 && (
        <progress
          className="h-2 w-full accent-brand"
          value={progress.completed + progress.skipped}
          max={progress.total}
          aria-label={`${card.content} 충돌 검사 진행률`}
        />
      )}
    </div>
  );
}
