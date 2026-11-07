"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Send } from "lucide-react";
import { toast } from "sonner";
import { isShareable } from "@shared/labels";
import type { Card, RelatedCard } from "@shared/types";
import { CandidateCard } from "@/components/review/candidate-card";
import { ExportUpload } from "@/components/review/export-upload";
import { PasteInput } from "@/components/review/paste-input";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { mockClassify, type Utterance } from "@/lib/classify";

export default function ReviewPage() {
  const router = useRouter();
  const [cards, setCards] = useState<Card[] | null>(null); // null = 아직 분류 전
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [classifying, setClassifying] = useState(false);
  const [sharing, setSharing] = useState(false);
  // 기존 세부 주제 목록 (분류기가 "기존 이름 먼저" 쓰도록). 실패해도 분류는 가능.
  // 분류 버튼을 목록 로딩 전에 눌러도 기다렸다가 쓰도록 Promise 로 보관
  const topicKeysRef = useRef<Promise<string[]> | null>(null);
  useEffect(() => {
    topicKeysRef.current = api
      .getBoard()
      .then((b) => [...new Set(b.map((c) => c.topic_key).filter((k): k is string => !!k))])
      .catch(() => []);
  }, []);

  const classify = async (utterances: Utterance[]) => {
    setClassifying(true);
    try {
      const topicKeys = (await topicKeysRef.current) ?? [];
      setCards(mockClassify(utterances, topicKeys));
      setPicked(new Set());
    } catch (e) {
      toast.error(`분류 실패: ${(e as Error).message}`);
    } finally {
      setClassifying(false);
    }
  };

  const { related, personalCount } = useMemo(() => {
    const related = (cards ?? []).filter((c): c is RelatedCard => c.relevance === "related");
    // 공유 가능한 것 먼저, 제안(none)은 아래로
    related.sort((a, b) => Number(a.tag === "none") - Number(b.tag === "none"));
    return { related, personalCount: (cards?.length ?? 0) - related.length };
  }, [cards]);

  const shareable = related.filter(isShareable);
  const selected = shareable.filter((c) => picked.has(c.id));

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const editContent = (id: string, content: string) =>
    setCards((prev) => prev?.map((c) => (c.id === id && c.relevance === "related" ? { ...c, content } : c)) ?? null);

  const share = async () => {
    setSharing(true);
    try {
      await api.approveItems(selected.map((c) => ({ ...c, content: c.content.trim() || c.sentence })));
      const ids = new Set(selected.map((c) => c.id));
      setCards((prev) => prev?.filter((c) => !ids.has(c.id)) ?? null);
      setPicked(new Set());
      toast.success(`${ids.size}장을 팀에 공유했어요`, {
        action: { label: "팀 보드 보기", onClick: () => router.push("/board") },
      });
    } catch (e) {
      toast.error(`공유 실패: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="space-y-gap-section pb-24">
      <div>
        <h1 className="text-2xl font-bold">개인 검토함</h1>
        <p className="text-sm text-muted-foreground">
          나만 보는 화면이에요. 분류된 후보 중 체크한 카드만 팀 보드에 올라가요.
        </p>
      </div>

      <Tabs defaultValue="paste" className="gap-3">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="paste">붙여넣기</TabsTrigger>
          <TabsTrigger value="export">내보내기 파일 업로드</TabsTrigger>
        </TabsList>
        <TabsContent value="paste">
          <PasteInput busy={classifying} onClassify={classify} />
        </TabsContent>
        <TabsContent value="export">
          <ExportUpload busy={classifying} onClassify={classify} />
        </TabsContent>
      </Tabs>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">분류 결과</h2>
          {shareable.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPicked(selected.length === shareable.length ? new Set() : new Set(shareable.map((c) => c.id)))}
            >
              {selected.length === shareable.length ? "선택 해제" : "공유 후보 모두 선택"}
            </Button>
          )}
        </div>

        {classifying && <p className="text-sm text-muted-foreground">분류 중…</p>}

        {!classifying && cards === null && (
          <EmptyState title="아직 분류한 대화가 없어요">
            <p>위에서 대화를 붙여넣거나 내보내기 파일을 올린 뒤 분류하기를 누르세요.</p>
          </EmptyState>
        )}

        {!classifying && cards !== null && (
          <>
            {personalCount > 0 && (
              <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                <EyeOff className="size-4" />
                개인 내용 {personalCount}개 숨김 (팀에 공유되지 않아요)
              </p>
            )}
            {related.length === 0 ? (
              <EmptyState title="팀에 공유할 만한 내용이 없어요" />
            ) : (
              <div className="space-y-3">
                {related.map((c) => (
                  <CandidateCard
                    key={c.id}
                    card={c}
                    checked={picked.has(c.id)}
                    onCheckedChange={(on) => toggle(c.id, on)}
                    onContentChange={(v) => editContent(c.id, v)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* 하단 고정 공유 바 */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-content items-center justify-between gap-3 px-gutter py-3">
          <p className="text-sm text-muted-foreground">
            <b className="text-foreground">{selected.length}장</b> 선택됨
          </p>
          <Button disabled={!selected.length || sharing} onClick={share}>
            <Send />
            {sharing ? "공유 중…" : "선택한 카드 팀에 공유"}
          </Button>
        </div>
      </div>
    </div>
  );
}
