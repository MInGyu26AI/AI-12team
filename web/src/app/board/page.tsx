"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { BADGE_COLOR } from "@shared/labels";
import { SUBTOPICS, type Conflict, type RelatedCard, type Tag } from "@shared/types";
import { BoardCard } from "@/components/board/board-card";
import { ConflictAlert } from "@/components/board/conflict-alert";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { USE_MOCK, api } from "@/lib/api";
import { resetMockData } from "@/lib/api/mock";
import { boardToMarkdown } from "@/lib/record";

type Filter = "all" | Exclude<Tag, "none">;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "decision", label: "결정" },
  { value: "todo", label: "할 일" },
  { value: "research", label: "조사" },
];

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; cards: RelatedCard[]; conflicts: Conflict[] };

// 같은 topic_key 끼리 붙여서 보여주기 (처음 나온 순서 유지 = 시간순)
const groupByTopic = (cards: RelatedCard[]) => [...Map.groupBy(cards, (c) => c.topic_key ?? "").values()].flat();

export default function BoardPage() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [filter, setFilter] = useState<Filter>("all");

  const refresh = useCallback(async () => {
    try {
      const [cards, conflicts] = await Promise.all([api.getBoard(), api.getConflicts()]);
      setLoad({ state: "ready", cards, conflicts });
    } catch (e) {
      setLoad({ state: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 마운트 시 서버에서 한 번 불러옴
    refresh();
  }, [refresh]);

  const copyRecord = async () => {
    if (load.state !== "ready") return;
    try {
      await navigator.clipboard.writeText(boardToMarkdown(load.cards, load.conflicts));
      toast.success("복사됨! ChatGPT나 Claude에 붙여넣으세요");
    } catch {
      toast.error("클립보드 복사에 실패했어요. 브라우저 권한을 확인해 주세요");
    }
  };

  return (
    <div className="space-y-gap-section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">팀 결정 보드</h1>
          <p className="text-sm text-muted-foreground">팀원이 승인해서 공유한 결정·할 일·조사</p>
        </div>
        <Button onClick={copyRecord} disabled={load.state !== "ready" || !load.cards.length}>
          <ClipboardCopy />
          팀 기록 복사
        </Button>
      </div>

      {load.state === "loading" && <LoadingState />}
      {load.state === "error" && (
        <ErrorState
          message={load.message}
          onRetry={() => {
            setLoad({ state: "loading" });
            refresh();
          }}
        />
      )}

      {load.state === "ready" && (
        <>
          <ConflictAlert conflicts={load.conflicts} onResolved={refresh} />

          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <TabsList className="w-full sm:w-fit">
              {FILTERS.map((f) => (
                <TabsTrigger key={f.value} value={f.value}>
                  {f.label}
                  <span className="text-xs text-muted-foreground">
                    {f.value === "all" ? load.cards.length : load.cards.filter((c) => c.tag === f.value).length}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <BoardSections cards={load.cards.filter((c) => filter === "all" || c.tag === filter)} total={load.cards.length} />
        </>
      )}

      {USE_MOCK && (
        <p className="text-center text-xs text-muted-foreground">
          목업 데이터 사용 중 ·{" "}
          <button
            className="underline"
            onClick={() => {
              resetMockData();
              setLoad({ state: "loading" });
              refresh();
              toast("목업 데이터를 처음 상태로 되돌렸어요");
            }}
          >
            초기화
          </button>
        </p>
      )}
    </div>
  );
}

function BoardSections({ cards, total }: { cards: RelatedCard[]; total: number }) {
  if (!total) {
    return (
      <EmptyState title="아직 공유된 카드가 없어요">
        <p>
          <Link href="/review" className="underline">
            개인 검토함
          </Link>
          에서 대화를 분류하고 승인하면 여기에 보여요.
        </p>
      </EmptyState>
    );
  }
  if (!cards.length) return <EmptyState title="이 분류에는 카드가 없어요" />;

  return (
    <div className="space-y-gap-section">
      {SUBTOPICS.map((subtopic) => {
        const list = cards.filter((c) => (c.subtopic ?? "기타") === subtopic);
        if (!list.length) return null;
        return (
          <section key={subtopic} className="space-y-3">
            <h2 className="flex items-center gap-2">
              <Badge variant="outline" className={`h-6 px-2.5 text-sm ${BADGE_COLOR.subtopic}`}>
                {subtopic}
              </Badge>
              <span className="text-sm text-muted-foreground">{list.length}</span>
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {groupByTopic(list).map((c) => (
                <BoardCard key={c.id} card={c} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
