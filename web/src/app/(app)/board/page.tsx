"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { fmtMDHM, timeOf } from "@shared/format";
import type { Judgement, RelatedCard } from "@shared/types";
import { ConflictBanner } from "@/components/board/conflict-banner";
import { ConflictChecks } from "@/components/board/conflict-checks";
import { DecisionHistoryList } from "@/components/board/decision-history";
import { DecisionTimeline, TopicFilter } from "@/components/board/decision-timeline";
import { ResearchPanel } from "@/components/board/research-panel";
import { TodoPanel } from "@/components/board/todo-panel";
import { ConflictDialog } from "@/components/conflict-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { USE_MOCK, api } from "@/lib/api";
import { resetMockData } from "@/lib/api/mock";
import { boardToMarkdown } from "@/lib/board-markdown";
import { useBoard } from "@/lib/use-board";

// 피그마 6번: 팀 결정 기록 보드
export default function BoardPage() {
  const { load, refresh, reload } = useBoard();
  const [topic, setTopic] = useState<string | null>(null); // 왼쪽 세부 주제 필터
  const [dialog, setDialog] = useState(false);

  if (load.state !== "ready") {
    return <Shell>{load.state === "loading" ? <LoadingState /> : <ErrorState message={load.message} onRetry={reload} />}</Shell>;
  }

  const { cards, conflicts, done } = load;
  const { decisions, todos, research, topics, lastUpdate } = boardSections(cards);
  const shown = topic ? decisions.filter((c) => topicOf(c) === topic) : decisions;
  const flagged = new Map<string, Judgement>(conflicts.map((x) => [x.cardB.id, x.judgement]));

  const copyRecord = async () => {
    try {
      await navigator.clipboard.writeText(boardToMarkdown(cards, conflicts));
      toast.success("복사됨! ChatGPT나 Claude에 붙여넣으세요");
    } catch {
      toast.error("클립보드 복사에 실패했어요. 브라우저 권한을 확인해 주세요");
    }
  };

  // 실패하면 서버가 준 이유를 그대로 보여 준다 (권한 회수·대상 없음과 연결 실패를 구분)
  const toggleTodo = async (id: string, on: boolean) => {
    try {
      await api.setTodoDone(id, on);
      await refresh();
    } catch (error) {
      toast.error(`저장하지 못했어요: ${(error as Error).message}`);
    }
  };

  const retryCheck = async (id: string) => {
    try {
      await api.retryCheck(id);
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const resetMock = () => {
    resetMockData();
    reload();
    toast("목업 데이터를 처음 상태로 되돌렸어요");
  };

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">팀 결정 기록</h1>
          <p className="text-muted-foreground">
            결정 {decisions.length}개 · 할 일 {todos.length}개{lastUpdate > 0 && ` · 마지막 업데이트 ${fmtMDHM(new Date(lastUpdate))}`}
          </p>
        </div>
        <Button onClick={copyRecord} disabled={!cards.length} className="h-11 bg-brand px-5 hover:bg-brand-hover">
          <Copy />
          팀 기록 복사
        </Button>
      </div>
      <DecisionHistoryList />
      <ConflictChecks cards={cards} onRetry={retryCheck} />
      {conflicts.length > 0 && <ConflictBanner conflicts={conflicts} onOpen={() => setDialog(true)} />}

      {!cards.length ? (
        <EmptyState title="아직 팀에 올라온 결정이 없어요">
          <p>승인함에서 내용을 골라 올리면 여기에 쌓여요.</p>
        </EmptyState>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)_300px]">
          <TopicFilter topics={topics} total={decisions.length} active={topic} onChange={setTopic} />
          <DecisionTimeline decisions={shown} flagged={flagged} onOpenConflict={() => setDialog(true)} />
          <div className="space-y-5">
            <TodoPanel todos={todos} done={done} onToggle={toggleTodo} />
            {research.length > 0 && <ResearchPanel research={research} />}
          </div>
        </div>
      )}

      {USE_MOCK && (
        <p className="text-center text-xs text-muted-foreground">
          목업 데이터 사용 중 ·{" "}
          <button className="underline" onClick={resetMock}>
            초기화
          </button>
        </p>
      )}

      {dialog && conflicts.length > 0 && (
        <ConflictDialog conflicts={conflicts} onClose={() => setDialog(false)} onResolved={refresh} />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-wide space-y-6 px-gutter py-10">{children}</div>;
}

const topicOf = (c: RelatedCard) => c.topic_key ?? "기타";
const newestFirst = (a: RelatedCard, b: RelatedCard) => timeOf(b.source) - timeOf(a.source);
// 기한이 빠른 순 (기한 없으면 뒤로), 같으면 먼저 나온 순
const byDue = (a: RelatedCard, b: RelatedCard) =>
  (a.due ?? "9999").localeCompare(b.due ?? "9999") || timeOf(a.source) - timeOf(b.source);

function boardSections(cards: RelatedCard[]) {
  const decisions = cards.filter((c) => c.tag === "decision").sort(newestFirst);
  const counts = new Map<string, number>(); // 세부 주제 → 결정 수 (최신 결정이 나온 주제부터)
  for (const c of decisions) counts.set(topicOf(c), (counts.get(topicOf(c)) ?? 0) + 1);
  return {
    decisions,
    todos: cards.filter((c) => c.tag === "todo").sort(byDue),
    research: cards.filter((c) => c.tag === "research").sort(newestFirst),
    topics: [...counts].map(([key, count]) => ({ key, count })),
    lastUpdate: cards.reduce((m, c) => Math.max(m, timeOf(c.source)), 0),
  };
}
