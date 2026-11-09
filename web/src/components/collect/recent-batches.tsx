"use client";

import Link from "next/link";
import type { BatchRecord } from "@shared/bridge";
import { fmtMDHM } from "@shared/format";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 최근 수집 (분류를 마친 묶음 6개까지): 묶음마다 아직 승인함에 남은 후보 수
export function RecentBatches({ batches, pendingIds, emptyText }: {
  batches: BatchRecord[] | null; // null = 수집기에 연결되지 않음
  pendingIds: Set<string>; // 지금 승인함에 남아 있는 후보 id
  emptyText: string;
}) {
  return (
    <section className="rounded-xl border bg-card p-6">
      <h2 className="border-b pb-4 font-semibold">최근 수집</h2>
      {!batches?.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y">
          {batches.slice(0, 6).map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 py-4">
              <div className="min-w-0">
                <p className="font-medium">{b.site} 대화 수집</p>
                <p className="text-sm text-muted-foreground">
                  대화 {b.turns}회 · {fmtMDHM(new Date(b.at))}
                  {b.trigger === "selection" && " · 선택한 내용"}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
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
        <span className="rounded-full bg-tag-todo-soft px-3 py-1 text-sm font-semibold text-tag-todo">승인 대기 {waiting}건</span>
        <Link href="/review" className={cn(buttonVariants(), "h-10 bg-brand px-4 hover:bg-brand-hover")}>
          승인함 보기
        </Link>
      </>
    );
  if (cardIds.length) return <span className="rounded-full bg-ok-soft px-3 py-1 text-sm font-semibold text-ok">검토 완료 {cardIds.length}건</span>;
  return <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">팀 관련 내용 없음</span>;
}
