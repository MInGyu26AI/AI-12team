"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EyeOff, Puzzle, Send } from "lucide-react";
import { toast } from "sonner";
import { mockClassify, type Utterance } from "@shared/classify";
import { isShareable } from "@shared/labels";
import type { Card, RelatedCard } from "@shared/types";
import { CandidateCard } from "@/components/review/candidate-card";
import { ExportUpload } from "@/components/review/export-upload";
import { PasteInput } from "@/components/review/paste-input";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { CURRENT_USER, KNOWN_NAMES } from "@/lib/me";
import { useExtensionBridge } from "@/lib/use-extension-bridge";

// 공유 가능한 것 먼저, 제안(none)은 아래로
const sortForReview = (list: RelatedCard[]) =>
  [...list].sort((a, b) => Number(a.tag === "none") - Number(b.tag === "none"));

export default function ReviewPage() {
  const router = useRouter();
  const ext = useExtensionBridge();

  const [cards, setCards] = useState<Card[] | null>(null); // 붙여넣기·업로드 분류 결과. null = 아직 분류 전
  const [extEdits, setExtEdits] = useState<Record<string, string>>({}); // 확장 카드 내용 수정분
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [classifying, setClassifying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [tab, setTab] = useState<string | null>(null); // null = 자동(확장 카드가 있으면 그 탭)

  // 기존 세부 주제 목록 (분류기가 "기존 이름 먼저" 쓰도록). 실패해도 분류는 가능.
  // 분류 버튼을 목록 로딩 전에 눌러도 기다렸다가 쓰도록 Promise 로 보관
  const topicKeysRef = useRef<Promise<string[]> | null>(null);
  const [boardKeys, setBoardKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    topicKeysRef.current = api
      .getBoard()
      .then((b) => [...new Set(b.map((c) => c.topic_key).filter((k): k is string => !!k))])
      .catch(() => []);
    topicKeysRef.current.then((keys) => setBoardKeys(new Set(keys)));
  }, []);

  const userName = ext.userName ?? CURRENT_USER;

  const classify = async (utterances: Utterance[]) => {
    setClassifying(true);
    try {
      const existingTopicKeys = (await topicKeysRef.current) ?? [];
      setCards(mockClassify(utterances, { userName, knownNames: [...new Set([userName, ...KNOWN_NAMES])], existingTopicKeys }));
      setPicked(new Set());
    } catch (e) {
      toast.error(`분류 실패: ${(e as Error).message}`);
    } finally {
      setClassifying(false);
    }
  };

  const { related, personalCount } = useMemo(() => {
    const related = sortForReview((cards ?? []).filter((c): c is RelatedCard => c.relevance === "related"));
    return { related, personalCount: (cards?.length ?? 0) - related.length };
  }, [cards]);

  // 확장은 팀 보드를 모르므로 "새 주제" 여부는 웹에서 보드 기준으로 다시 판단
  const extCards = useMemo(
    () =>
      sortForReview(
        ext.cards.map((c) => ({
          ...c,
          content: c.id in extEdits ? extEdits[c.id]! : c.content,
          is_new_topic: boardKeys && c.topic_key ? !boardKeys.has(c.topic_key) : c.is_new_topic,
        })),
      ),
    [ext.cards, extEdits, boardKeys],
  );
  const extIds = useMemo(() => new Set(ext.cards.map((c) => c.id)), [ext.cards]);

  const activeTab = tab ?? (ext.available && ext.cards.length ? "extension" : "paste");
  const visible = activeTab === "extension" ? extCards : related; // 지금 보이는 목록
  const shareableVisible = visible.filter(isShareable);
  const selected = [...extCards, ...related].filter((c) => isShareable(c) && picked.has(c.id));

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const editContent = (id: string, content: string) => {
    if (extIds.has(id)) setExtEdits((prev) => ({ ...prev, [id]: content }));
    else setCards((prev) => prev?.map((c) => (c.id === id && c.relevance === "related" ? { ...c, content } : c)) ?? null);
  };

  const dropLocal = (ids: Set<string>) => {
    setCards((prev) => prev?.filter((c) => !ids.has(c.id)) ?? null);
    setPicked((prev) => new Set([...prev].filter((id) => !ids.has(id))));
  };

  const dismiss = (id: string) => {
    if (extIds.has(id)) ext.remove([id], "dismissed");
    dropLocal(new Set([id]));
  };

  const share = async () => {
    setSharing(true);
    try {
      await api.approveItems(selected.map((c) => ({ ...c, content: c.content.trim() || c.sentence })));
      const ids = new Set(selected.map((c) => c.id));
      ext.remove(selected.filter((c) => extIds.has(c.id)).map((c) => c.id), "approved");
      dropLocal(ids);
      toast.success(`${ids.size}장을 팀에 공유했어요`, {
        action: { label: "팀 보드 보기", onClick: () => router.push("/board") },
      });
    } catch (e) {
      toast.error(`공유 실패: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  const renderList = (list: RelatedCard[]) => (
    <div className="space-y-3">
      {list.map((c) => (
        <CandidateCard
          key={c.id}
          card={c}
          checked={picked.has(c.id)}
          onCheckedChange={(on) => toggle(c.id, on)}
          onContentChange={(v) => editContent(c.id, v)}
          onDismiss={() => dismiss(c.id)}
        />
      ))}
    </div>
  );

  const selectAllButton = shareableVisible.length > 0 && (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        const allOn = shareableVisible.every((c) => picked.has(c.id));
        setPicked((prev) => {
          const next = new Set(prev);
          shareableVisible.forEach((c) => (allOn ? next.delete(c.id) : next.add(c.id)));
          return next;
        });
      }}
    >
      {shareableVisible.every((c) => picked.has(c.id)) ? "선택 해제" : "공유 후보 모두 선택"}
    </Button>
  );

  return (
    <div className="space-y-gap-section pb-24">
      <div>
        <h1 className="text-2xl font-bold">개인 검토함</h1>
        <p className="text-sm text-muted-foreground">
          나만 보는 화면이에요. 분류된 후보 중 체크한 카드만 팀 보드에 올라가요.
        </p>
      </div>

      {ext.checked && !ext.available && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <Puzzle className="size-4" />
          싱크업 확장 프로그램을 설치하면 ChatGPT 대화를 자동으로 가져와요.
          <Link href="/install" className="font-medium text-foreground underline">
            설치 방법 보기
          </Link>
        </p>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setTab(String(v))} className="gap-3">
        <TabsList className="h-auto w-full flex-wrap sm:w-fit">
          {ext.available && (
            <TabsTrigger value="extension">
              <Puzzle />
              확장프로그램에서 가져온 카드 {ext.cards.length}개
            </TabsTrigger>
          )}
          <TabsTrigger value="paste">붙여넣기</TabsTrigger>
          <TabsTrigger value="export">내보내기 파일 업로드</TabsTrigger>
        </TabsList>

        {ext.available && (
          <TabsContent value="extension" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                ChatGPT에서 자동 수집·분류된 카드예요. 개인 내용은 이미 버렸고 민감정보는 가렸어요.
              </p>
              {selectAllButton}
            </div>
            {extCards.length === 0 ? (
              <EmptyState title="검토 대기 카드가 없어요">
                <p>확장 팝업에서 자동 수집을 켜거나, ChatGPT 화면의 “싱크업에 보내기” 버튼을 눌러 보세요.</p>
              </EmptyState>
            ) : (
              renderList(extCards)
            )}
          </TabsContent>
        )}
        <TabsContent value="paste">
          <PasteInput busy={classifying} onClassify={classify} />
        </TabsContent>
        <TabsContent value="export">
          <ExportUpload busy={classifying} onClassify={classify} />
        </TabsContent>
      </Tabs>

      {activeTab !== "extension" && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">분류 결과</h2>
            {selectAllButton}
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
              {related.length === 0 ? <EmptyState title="팀에 공유할 만한 내용이 없어요" /> : renderList(related)}
            </>
          )}
        </section>
      )}

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
