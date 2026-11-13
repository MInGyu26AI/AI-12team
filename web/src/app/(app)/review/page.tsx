"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PERSONAL_COLOR, TAG_COLOR } from "@shared/labels";
import type { Conflict, RelatedCard } from "@shared/types";
import { ConflictDialog } from "@/components/conflict-dialog";
import { ExtensionMissingDialog } from "@/components/extension-missing-dialog";
import { CandidateList } from "@/components/review/candidate-list";
import { ExcludedMessages, HeldBatches, PrivacyTab } from "@/components/review/privacy-review";
import { ReviewNotices } from "@/components/review/review-notices";
import { ShareBar } from "@/components/review/share-bar";
import { LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, USE_MOCK } from "@/lib/api";
import { useTeam } from "@/lib/team";
import { useReviewCandidates, useReviewSelection } from "@/lib/use-review";
import { cn } from "@/lib/utils";

type Tab = "review" | "held" | "excluded";

const LEGEND = [
  { label: "결정", color: TAG_COLOR.decision },
  { label: "조사", color: TAG_COLOR.research },
  { label: "할 일", color: TAG_COLOR.todo },
  { label: "개인", color: PERSONAL_COLOR },
];

// 피그마 4번: 분류 결과 + 승인 (수집기 후보 + 목업 모드의 붙여넣기 후보)
export default function ReviewPage() {
  const router = useRouter();
  const team = useTeam();
  const review = useReviewCandidates();
  const { collector } = review;
  const selection = useReviewSelection(review.shareable);
  const [sharing, setSharing] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [syncing, setSyncing] = useState(false);

  // 승인함에 들어오면 쌓인 대화를 한 번 분류에 넣는다 (상태를 처음 받은 뒤. 짧은 시간 안의 재진입은 건너뜀)
  const statusReady = !!collector.status;
  const { autoSync } = collector;
  useEffect(() => {
    if (statusReady) void autoSync();
  }, [statusReady, autoSync]);
  const syncNow = async () => {
    setSyncing(true);
    await collector.sync();
    setSyncing(false);
  };

  // 팀을 바꾸면 이전 팀에서 고른 체크와 충돌 경고를 버린다 (개인정보 목록은 아래에서 팀 id 로 다시 그린다)
  const teamId = collector.status?.teamId;
  const [shownTeam, setShownTeam] = useState(teamId);
  if (teamId !== shownTeam) {
    setShownTeam(teamId);
    selection.clear();
    setConflicts(null);
  }

  const share = async () => {
    const picked = selection.selected;
    setSharing(true);
    try {
      const { conflicts: found } = await api.approveItems(picked.map(withContent), teamId);
      review.drop(picked.map((c) => c.id), "approved");
      selection.clear();
      if (found.length) {
        setConflicts(found); // 피그마 5번: 올린 결정 중 기존 결정과 어긋난 것
        toast.warning(`${picked.length}개를 올렸어요. 기존 결정과 어긋나는 내용이 ${found.length}건 있어요`);
      } else {
        toast.success(USE_MOCK ? `${picked.length}개를 팀 결정 기록에 올렸어요` : `${picked.length}개 승인 저장됨 · 팀 전송 대기`, {
          action: { label: "팀 결정 기록 보기", onClick: () => router.push("/board") },
        });
      }
    } catch (e) {
      toast.error(`공유 실패: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  const subtitle = subtitleOf(review, collector.status?.userName ?? team.me);
  const held = collector.privacy.list?.items ?? [];
  const excluded = collector.privacy.list?.excluded ?? [];
  const excludedCount = collector.privacy.list?.excludedCount ?? 0;
  const retryPrivacy = () => void collector.refresh();

  return (
    <div className="mx-auto max-w-content space-y-6 px-gutter pt-10 pb-32">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-3xl font-bold">팀에 올릴 내용을 골라 주세요</h1>
          {!USE_MOCK && (
            <Button variant="outline" onClick={syncNow} disabled={syncing || !collector.available}>
              <RefreshCw className={cn(syncing && "animate-spin")} />
              {syncing ? "맞추는 중…" : "싱크 맞추기"}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground break-keep">{subtitle}</p>
        <div className="flex flex-wrap gap-1.5">
          {LEGEND.map(({ label, color }) => (
            <span key={label} className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", color)}>
              {label}
            </span>
          ))}
        </div>
      </div>
      <ReviewNotices collector={collector} queued={review.queued} />
      <ExtensionMissingDialog missing={collector.extensionMissing} />

      {!collector.checked ? (
        <LoadingState label="검토 후보를 불러오는 중…" />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
          <TabsList className="w-full sm:w-fit" aria-label="검토 상태">
            <TabsTrigger value="review">승인 대기 <Badge variant="secondary">{review.shareable.length}</Badge></TabsTrigger>
            <TabsTrigger value="held">확인 필요 <Badge variant="secondary">{held.length}</Badge></TabsTrigger>
            <TabsTrigger value="excluded">제외됨 <Badge variant="secondary">{excludedCount}</Badge></TabsTrigger>
          </TabsList>
          <TabsContent value="review">
            <CandidateList review={review} selection={selection} othersOpen={showOthers} onToggleOthers={() => setShowOthers((v) => !v)} />
          </TabsContent>
          <TabsContent value="held" className="space-y-4">
            <PrivacyTab error={collector.privacy.error} onRetry={retryPrivacy}>
              {teamId && (
                <HeldBatches key={teamId} items={held} teamId={teamId} modelAvailable={collector.status?.privacy?.available}
                  onAction={collector.privacyAction} onRefresh={collector.refresh} />
              )}
            </PrivacyTab>
          </TabsContent>
          <TabsContent value="excluded" className="space-y-4">
            <PrivacyTab error={collector.privacy.error} onRetry={retryPrivacy}>
              {teamId && <ExcludedMessages key={teamId} items={excluded} total={excludedCount} />}
            </PrivacyTab>
          </TabsContent>
        </Tabs>
      )}

      {tab === "review" && (review.shareable.length > 0 || review.personal > 0) && (
        <ShareBar selected={selection.selected.length} personal={review.personal} canSelect={selection.canSelect}
          allSelected={selection.allSelected} sharing={sharing} onToggleAll={selection.toggleAll} onShare={share} />
      )}

      {conflicts && (
        <ConflictDialog
          conflicts={conflicts}
          onClose={() => {
            setConflicts(null);
            router.push("/board");
          }}
        />
      )}
    </div>
  );
}

function subtitleOf(review: ReturnType<typeof useReviewCandidates>, who: string) {
  if (review.collector.cards.length) {
    return `${who} 님의 로컬 검토함에 후보 ${review.shareable.length}개가 있어요. 체크하고 승인한 카드만 팀에 공유해요.`;
  }
  if (review.pastedCount) {
    return `${review.pastedLabel}에서 후보 ${review.shareable.length}개를 찾았어요. 체크한 것만 팀 결정 기록에 올라가요.`;
  }
  return "브라우저 확장이 모은 대화나 붙여넣은 대화에서 팀에 올릴 후보를 골라요.";
}

// 내용을 비워 저장한 카드는 원문 문장으로 올린다 (목업 붙여넣기 카드용. 수집기 카드는 이미 저장된 내용을 쓴다)
const withContent = (c: RelatedCard) => ({ ...c, content: c.content.trim() || c.sentence });
