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
import { EmptyState } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { api } from "@/lib/api";
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
    return [...fromExt, ...local.cards].sort((a, b) => ORDER[a.tag] - ORDER[b.tag]);
  }, [ext.cards, extEdits, boardKeys, local.cards]);

  const shareable = all.filter(isShareable);
  const others = all.filter((c) => c.tag === "none"); // 해당 없음 (요청·제안·AI 답변)
  const isChecked = (c: RelatedCard) => overrides[c.id] ?? c.confidence >= LOW_CONFIDENCE;
  const selected = shareable.filter(isChecked);

  // 개인 내용 수: 붙여넣기 결과 + 지금 남아 있는 확장 카드가 나온 수집 묶음
  const recent = ext.status?.recent ?? [];
  const extBatches = recent.filter((b) => b.cardIds.some((id) => extIds.has(id)));
  const personal = local.personal + extBatches.reduce((n, b) => n + (b.personal ?? 0), 0);
  const turns = extBatches.reduce((n, b) => n + b.turns, 0);
  const who = ext.userName ?? team.me;

  const editContent = (id: string, content: string) => {
    if (extIds.has(id)) setExtEdits((p) => ({ ...p, [id]: content }));
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
        toast.success(`${selected.length}개를 팀 결정 기록에 올렸어요`, {
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
    ? `브라우저 확장이 ${who} 님의 ChatGPT 대화 ${turns || "여러"}회를 자동 수집했어요. 후보 ${shareable.length}개 중 체크한 것만 팀 결정 기록에 올라가요.`
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
            />
          ))}

          {personal > 0 && (
            <article className="flex gap-4 rounded-xl border bg-muted/40 p-5 text-muted-foreground">
              <EyeOff className="mt-0.5 size-5 shrink-0" />
              <div className="space-y-1.5">
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", PERSONAL_COLOR)}>개인</span>
                <p className="text-[17px]">개인 내용 {personal}개</p>
                <p className="text-sm">개인 내용은 기본으로 제외돼요. 내용은 저장하지 않아요.</p>
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

      {/* 하단 고정 바 (피그마: "4개 선택됨 · 개인 1개 제외 [전체 해제] [선택한 4개 팀에 올리기]") */}
      {(shareable.length > 0 || personal > 0) && (
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
