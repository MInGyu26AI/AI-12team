"use client";

import Link from "next/link";
import { ChevronDown, EyeOff } from "lucide-react";
import { TURNS_PER_BATCH } from "@shared/batch";
import { PERSONAL_COLOR, TAG_COLOR } from "@shared/labels";
import type { RelatedCard } from "@shared/types";
import { CandidateCard } from "@/components/review/candidate-card";
import { EmptyState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { collectorLink, type CollectorLink } from "@/lib/local-collector";
import type { useReviewCandidates, useReviewSelection } from "@/lib/use-review";
import { cn } from "@/lib/utils";

type Review = ReturnType<typeof useReviewCandidates>;
type Selection = ReturnType<typeof useReviewSelection>;

// 승인 대기 탭: 공유 후보 카드 · 개인 내용 수 · 공유 후보 아닌 내용(접힘).
// 접힘 상태는 탭을 바꿔도 남도록 화면(page)이 들고 있다 (탭 패널은 숨기면 사라진다)
export function CandidateList({ review, selection, othersOpen, onToggleOthers }: {
  review: Review;
  selection: Selection;
  othersOpen: boolean;
  onToggleOthers: () => void;
}) {
  const { collector } = review;
  if (!review.total && !review.personal) return <NoCandidates link={collectorLink(collector)} />;
  return (
    <div className="space-y-4">
      {review.shareable.map((c) => (
        <CandidateCard
          key={c.id}
          card={c}
          checked={selection.isChecked(c)}
          onCheckedChange={(on) => selection.setChecked(c.id, on)}
          onContentChange={(v) => review.editContent(c.id, v)}
          onDismiss={() => review.drop([c.id], "dismissed")}
          onConfirmUser={() => collector.action("candidates.update", { id: c.id, patch: { confirmedRole: "user" } })}
          onEvidenceChange={
            review.fromCollector(c.id)
              ? (sentence) => collector.action("candidates.update", { id: c.id, patch: { sentence } })
              : undefined
          }
        />
      ))}
      {review.personal > 0 && <PersonalNote count={review.personal} />}
      {review.others.length > 0 && (
        <OtherContent cards={review.others} open={othersOpen} onToggle={onToggleOthers} onDismiss={(id) => review.drop([id], "dismissed")} />
      )}
    </div>
  );
}

const NO_CANDIDATE_TEXT: Record<CollectorLink, string> = {
  connected: `ChatGPT에서 대화를 ${TURNS_PER_BATCH}회 나누면 후보가 자동으로 올라와요. 바로 확인하려면 '싱크 맞추기'를 눌러 주세요.`,
  "collector-off": "로컬 수집기가 꺼져 있어요. 수집기를 실행하거나 대화를 직접 붙여넣어 보세요.",
  "extension-missing": "브라우저 확장을 설치하거나 대화를 직접 붙여넣어 보세요.",
  checking: "수집기 연결을 확인하는 중이에요.",
};

function NoCandidates({ link }: { link: CollectorLink }) {
  return (
    <EmptyState title="승인할 후보가 없어요">
      <p className="break-keep">{NO_CANDIDATE_TEXT[link]}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <Link href="/collect" className={cn(buttonVariants({ variant: "outline" }))}>
          대화 수집 상태
        </Link>
        <Link href="/collect/paste" className={cn(buttonVariants(), "bg-brand hover:bg-brand-hover")}>
          대화 직접 붙여넣기
        </Link>
      </div>
    </EmptyState>
  );
}

function PersonalNote({ count }: { count: number }) {
  return (
    <article className="flex gap-4 rounded-xl border bg-muted/40 p-5 text-muted-foreground">
      <EyeOff className="mt-0.5 size-5 shrink-0" />
      <div className="space-y-1.5">
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", PERSONAL_COLOR)}>개인</span>
        <p className="text-[17px]">개인 내용 {count}개</p>
        <p className="text-sm">개인 내용은 팀에 올리지 않아요.</p>
      </div>
    </article>
  );
}

// 요청·제안·AI 답변처럼 공유 후보가 아닌 내용 (기본 접힘)
function OtherContent({ cards, open, onToggle, onDismiss }: {
  cards: RelatedCard[];
  open: boolean;
  onToggle: () => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border bg-card">
      <button
        className="flex w-full items-center justify-between px-5 py-3 text-sm text-muted-foreground"
        onClick={onToggle}
        aria-expanded={open}
      >
        공유 후보 아닌 내용 {cards.length}개 (요청·제안·AI 답변)
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="divide-y border-t">
          {cards.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-5 py-3 text-sm text-muted-foreground">
              <span className={cn("rounded-full px-2 py-0.5 text-xs", TAG_COLOR.none)}>제안</span>
              <span className="min-w-0 flex-1 break-keep">{c.content}</span>
              <button className="text-xs underline" onClick={() => onDismiss(c.id)}>
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
