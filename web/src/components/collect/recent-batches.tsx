"use client";

import Link from "next/link";
import type { BatchRecord } from "@shared/bridge";
import { fmtMDHM } from "@shared/format";
import { SITE_LABEL } from "@shared/labels";
import { buttonPrimary, card, chip } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 최근 수집 (분류를 마친 묶음 6개까지): 묶음마다 아직 승인함에 남은 후보 수. 피그마 3번 '최근 수집' 카드 (152:198)
export function RecentBatches({ batches, pendingIds, emptyText }: {
  batches: BatchRecord[] | null; // null = 수집기에 연결되지 않음
  pendingIds: Set<string>; // 지금 승인함에 남아 있는 후보 id
  emptyText: string;
}) {
  return (
    <section className={cn(card, "p-5")}>
      <h2 className="pb-2 text-base leading-[1.5] font-medium">최근 수집</h2>
      {!batches?.length ? (
        <p className="border-t border-card-border py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul>
          {batches.slice(0, 6).map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 border-t border-card-border py-3">
              <div className="min-w-0 leading-[1.5]">
                <p className="text-[15px] font-medium">{SITE_LABEL[b.site] ?? b.site} 대화 수집</p>
                <p className="text-xs text-muted-foreground">
                  대화 {b.turns}회 · {fmtMDHM(new Date(b.at))}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <BatchReviewState cardIds={b.cardIds} waiting={b.cardIds.filter((id) => pendingIds.has(id)).length} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BatchReviewState({ cardIds, waiting }: { cardIds: string[]; waiting: number }) {
  if (waiting > 0)
    return (
      <>
        <span className={cn(chip, "bg-tag-todo-soft text-tag-todo")}>승인 대기 {waiting}건</span>
        <Link href="/review" className={buttonPrimary}>
          승인함 보기
        </Link>
      </>
    );
  if (cardIds.length) return <span className={cn(chip, "bg-ok-soft text-ok")}>검토 완료 {cardIds.length}건</span>;
  return <span className={cn(chip, "bg-muted text-muted-foreground")}>팀 관련 내용 없음</span>;
}
