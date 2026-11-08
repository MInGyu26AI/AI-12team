"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { LOW_CONFIDENCE, PERSONAL_COLOR, TAG_COLOR, isShareable } from "@shared/labels";
import type { Conflict, RelatedCard } from "@shared/types";
import { ConflictDialog } from "@/components/conflict-dialog";
import { CandidateCard } from "@/components/review/candidate-card";
import { ExcludedMessages, HeldBatches, PrivacyError } from "@/components/review/privacy-review";
import { EmptyState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, USE_MOCK } from "@/lib/api";
import { rpc } from "@/lib/rpc";
import { useLocalCandidates } from "@/lib/local-candidates";
import { useTeam } from "@/lib/team";
import { useExtensionBridge } from "@/lib/use-extension-bridge";
import { cn } from "@/lib/utils";

const ORDER = { decision: 0, research: 1, todo: 2, none: 3 } as const;

// 피그마 4번: 분류 결과 + 승인 (확장에서 온 후보 + 붙여넣기로 분류한 후보)
export default function ReviewPage() {
  const router = useRouter();
  const [team] = useTeam();
  const ext = useExtensionBridge();
  const local = useLocalCandidates();

  const [extEdits, setExtEdits] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({}); // 체크 바꾼 카드 (기본: 확신도 0.6 이상이면 체크)
  const [sharing, setSharing] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [tab, setTab] = useState<"review" | "held" | "excluded">("review");

  // Team switch: drop selections and edits made for the previous team (privacy lists are keyed by team below).
  const teamId = ext.status?.teamId;
  const [shownTeam, setShownTeam] = useState(teamId);
  if (teamId !== shownTeam) {
    setShownTeam(teamId);
    setOverrides({});
    setExtEdits({});
    setConflicts(null);
  }

  // 확장은 팀 보드를 모르므로 "새 주제" 여부는 보드 기준으로 다시 판단
  const [boardKeys, setBoardKeys] = useState<Set<string> | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api
      .getBoard()
      .then((b) => setBoardKeys(new Set(b.map((c) => c.topic_key).filter((k): k is string => !!k))))
      .catch(() => {});
  }, []);

  const extIds = useMemo(() => new Set(ext.cards.map((c) => c.id)), [ext.cards]);
  const all = useMemo(() => {
    const fromExt = ext.cards.map((c) => ({
      ...c,
      content: extEdits[c.id] ?? c.content,
      is_new_topic: boardKeys && c.topic_key ? !boardKeys.has(c.topic_key) : c.is_new_topic,
    }));
    return [...fromExt, ...(USE_MOCK ? local.cards : [])].sort((a, b) => ORDER[a.tag] - ORDER[b.tag]);
  }, [ext.cards, extEdits, boardKeys, local.cards]);

  const shareable = all.filter(isShareable).filter(c => !c.deliveryState);
  const queued = all.filter(c => c.deliveryState);
  const others = all.filter((c) => c.tag === "none"); // 해당 없음 (요청·제안·AI 답변)
  const isChecked = (c: RelatedCard) => !c.evidence?.roleGuessed && (overrides[c.id] ?? c.confidence >= LOW_CONFIDENCE);
  const selected = shareable.filter(isChecked);

  // 개인 내용 수: 붙여넣기 결과 + 지금 남아 있는 확장 카드가 나온 수집 묶음
  const recent = ext.status?.recent ?? [];
  const extBatches = recent.filter((b) => b.cardIds.some((id) => extIds.has(id)));
  const personal = local.personal + extBatches.reduce((n, b) => n + (b.personal ?? 0), 0);
  const who = ext.userName ?? team.me;
  const held = ext.privacy.list?.items ?? [];
  const excluded = ext.privacy.list?.excluded ?? [];
  const excludedCount = ext.privacy.list?.excludedCount ?? 0;

  const editContent = async (id: string, content: string) => {
    if (extIds.has(id)) {
      try { await rpc('candidates.update', { id, patch: { content } }); setExtEdits((p) => ({ ...p, [id]: content })); await ext.refresh(); }
      catch (error) { toast.error((error as Error).message); }
    }
    else local.edit(id, content);
  };

  const drop = (ids: string[], reason: "approved" | "dismissed") => {
    ext.remove(ids.filter((id) => extIds.has(id)), reason);
    local.remove(ids.filter((id) => !extIds.has(id)));
  };

  const share = async () => {
    setSharing(true);
    try {
      const { conflicts: found } = await api.approveItems(selected.map((c) => ({ ...c, content: c.content.trim() || c.sentence })));
      drop(selected.map((c) => c.id), "approved");
      setOverrides({});
      if (found.length) {
        setConflicts(found); // 피그마 5번: 올린 결정 중 기존 결정과 어긋난 것
        toast.warning(`${selected.length}개를 올렸어요. 기존 결정과 어긋나는 내용이 ${found.length}건 있어요`);
      } else {
        toast.success(USE_MOCK ? `${selected.length}개를 팀 결정 기록에 올렸어요` : `${selected.length}개 승인 저장됨 · 팀 전송 대기`, {
          action: { label: "팀 결정 기록 보기", onClick: () => router.push("/board") },
        });
      }
    } catch (e) {
      toast.error(`공유 실패: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  const subtitle = ext.cards.length
    ? `${who} 님의 로컬 검토함에 후보 ${shareable.length}개가 있어요. 체크하고 승인한 카드만 팀에 공유해요.`
    : local.cards.length
      ? `${local.label}에서 후보 ${shareable.length}개를 찾았어요. 체크한 것만 팀 결정 기록에 올라가요.`
      : "브라우저 확장이 모은 대화나 붙여넣은 대화에서 팀에 올릴 후보를 골라요.";

  return (
    <div className="mx-auto max-w-content space-y-6 px-gutter pt-10 pb-32">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold">팀에 올릴 내용을 골라 주세요</h1>
        <p className="text-muted-foreground break-keep">{subtitle}</p>
        <div className="flex flex-wrap gap-1.5">
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", TAG_COLOR.decision)}>결정</span>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", TAG_COLOR.research)}>조사</span>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", TAG_COLOR.todo)}>할 일</span>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", PERSONAL_COLOR)}>개인</span>
        </div>
      </div>
      {ext.error && !USE_MOCK && <p role="alert">{ext.error}</p>}
      {!USE_MOCK && ext.status && <p>승인 대상 · <strong>{ext.status.teamName}</strong> · {ext.status.userName}</p>}
      {(ext.status?.failedJobs ?? []).map(job => <div key={job.id} role="alert" className="rounded-xl border p-4">{job.detail} <Button variant="outline" onClick={() => ext.action('jobs.retry', { id: job.id })}>분류 재시도</Button></div>)}
      {!!ext.status?.legacyCandidates && <p>기존 검토 후보 {ext.status.legacyCandidates}개는 수집기를 시작할 때 표시된 개인 검토함 주소에서 계속 검토할 수 있어요.</p>}
      {queued.map(c => <article key={c.id} className="rounded-xl border p-5"><strong>{c.content}</strong><p role="status">{c.deliveryState === 'blocked' ? '전송 확인 필요' : '승인 저장됨 · 전송 대기'}</p>{c.deliveryState === 'blocked' && <Button onClick={() => ext.action('delivery.retry', { id: c.id })}>승인한 내용 그대로 재시도</Button>}</article>)}

      {!USE_MOCK && !ext.checked ? <LoadingState label="검토 후보를 불러오는 중…" /> : (
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="gap-4">
        <TabsList className="w-full sm:w-fit" aria-label="검토 상태">
          <TabsTrigger value="review">승인 대기 <Badge variant="secondary">{shareable.length}</Badge></TabsTrigger>
          <TabsTrigger value="held">확인 필요 <Badge variant="secondary">{held.length}</Badge></TabsTrigger>
          <TabsTrigger value="excluded">제외됨 <Badge variant="secondary">{excludedCount}</Badge></TabsTrigger>
        </TabsList>
        <TabsContent value="review">
      {!all.length && !personal ? (
        <EmptyState title="승인할 후보가 없어요">
          <p className="break-keep">
            {ext.available
              ? `ChatGPT에서 대화를 ${ext.status?.turnsPerBatch ?? 10}회 나누면 후보가 자동으로 올라와요.`
              : "브라우저 확장을 설치하거나 대화를 직접 붙여넣어 보세요."}
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Link href="/collect" className={cn(buttonVariants({ variant: "outline" }))}>
              대화 수집 상태
            </Link>
            <Link href="/collect/paste" className={cn(buttonVariants(), "bg-brand hover:bg-brand-hover")}>
              대화 직접 붙여넣기
            </Link>
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {shareable.map((c) => (
            <CandidateCard
              key={c.id}
              card={c}
              checked={isChecked(c)}
              onCheckedChange={(on) => setOverrides((p) => ({ ...p, [c.id]: on }))}
              onContentChange={(v) => editContent(c.id, v)}
              onDismiss={() => drop([c.id], "dismissed")}
              onConfirmRole={role => ext.action('candidates.update', { id: c.id, patch: { confirmedRole: role } })}
              onEvidenceChange={extIds.has(c.id) ? sentence => ext.action('candidates.update', { id: c.id, patch: { sentence } }) : undefined}
            />
          ))}

          {personal > 0 && (
            <article className="flex gap-4 rounded-xl border bg-muted/40 p-5 text-muted-foreground">
              <EyeOff className="mt-0.5 size-5 shrink-0" />
              <div className="space-y-1.5">
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", PERSONAL_COLOR)}>개인</span>
                <p className="text-[17px]">개인 내용 {personal}개</p>
                <p className="text-sm">개인 내용은 팀에 올리지 않아요.</p>
              </div>
            </article>
          )}

          {others.length > 0 && (
            <div className="rounded-xl border bg-card">
              <button
                className="flex w-full items-center justify-between px-5 py-3 text-sm text-muted-foreground"
                onClick={() => setShowOthers((v) => !v)}
                aria-expanded={showOthers}
              >
                공유 후보 아닌 내용 {others.length}개 (요청·제안·AI 답변)
                <ChevronDown className={cn("size-4 transition-transform", showOthers && "rotate-180")} />
              </button>
              {showOthers && (
                <ul className="divide-y border-t">
                  {others.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-5 py-3 text-sm text-muted-foreground">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs", PERSONAL_COLOR)}>제안</span>
                      <span className="min-w-0 flex-1 break-keep">{c.content}</span>
                      <button className="text-xs underline" onClick={() => drop([c.id], "dismissed")}>
                        지우기
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
        </TabsContent>
        <TabsContent value="held" className="space-y-4">
          {USE_MOCK ? <p className="text-muted-foreground">예시 모드에는 로컬 개인정보 검사 결과가 없어요.</p> : (
            <>
              {ext.privacy.error && <PrivacyError message={ext.privacy.error} onRetry={() => void ext.refresh()} />}
              {teamId && <HeldBatches key={teamId} items={held} teamId={teamId} modelAvailable={ext.status?.privacy?.available}
                onAction={ext.privacyAction} onRefresh={ext.refresh} />}
            </>
          )}
        </TabsContent>
        <TabsContent value="excluded" className="space-y-4">
          {USE_MOCK ? <p className="text-muted-foreground">예시 모드에는 로컬 개인정보 검사 결과가 없어요.</p> : (
            <>
              {ext.privacy.error && <PrivacyError message={ext.privacy.error} onRetry={() => void ext.refresh()} />}
              {teamId && <ExcludedMessages key={teamId} items={excluded} total={excludedCount} />}
            </>
          )}
        </TabsContent>
      </Tabs>
      )}

      {/* 하단 고정 바 (피그마: "4개 선택됨 · 개인 1개 제외 [전체 해제] [선택한 4개 팀에 올리기]") */}
      {tab === "review" && (shareable.length > 0 || personal > 0) && (
        <div className="fixed inset-x-0 bottom-0 z-20 px-gutter pb-4">
          <div className="mx-auto flex max-w-content flex-wrap items-center gap-3 rounded-xl border bg-background px-5 py-3 shadow-lg">
            <p className="text-sm text-muted-foreground">
              {selected.length}개 선택됨{personal > 0 && ` · 개인 ${personal}개 제외`}
            </p>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                className="h-10"
                disabled={!shareable.length}
                onClick={() =>
                  setOverrides(Object.fromEntries(shareable.map((c) => [c.id, selected.length !== shareable.length])))
                }
              >
                {selected.length === shareable.length && shareable.length ? "전체 해제" : "전체 선택"}
              </Button>
              <Button className="h-10 bg-brand px-4 hover:bg-brand-hover" disabled={!selected.length || sharing} onClick={share}>
                {sharing ? "올리는 중…" : `선택한 ${selected.length}개 팀에 올리기`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {conflicts && (
        <ConflictDialog
          conflicts={conflicts}
          onClose={() => {
            setConflicts(null);
            router.push("/board");
          }}
          onResolved={() => {}}
        />
      )}
    </div>
  );
}
