"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, FileText } from "lucide-react";
import { toast } from "sonner";
import { fmtMDHM, timeOf } from "@shared/format";
import { alertLevel } from "@shared/labels";
import { branchMatcher, branchNames, repoIndex } from "@shared/repo";
import type { RelatedCard } from "@shared/types";
import { BranchFilter } from "@/components/board/branch-filter";
import { ConflictBanner } from "@/components/board/conflict-banner";
import { ConflictChecks } from "@/components/board/conflict-checks";
import { DecisionHistoryList } from "@/components/board/decision-history";
import { BoardViewToggle, DecisionCarousel, useListOnly, type BoardView } from "@/components/board/decision-carousel";
import { DecisionTimeline, TopicFilter, type Flag } from "@/components/board/decision-timeline";
import { RepoStatusBar } from "@/components/board/repo-status";
import { ResearchPanel } from "@/components/board/research-panel";
import { TodoPanel } from "@/components/board/todo-panel";
import { ConflictDialog } from "@/components/conflict-dialog";
import { PageTitle } from "@/components/page-title";
import { WatercolorBg } from "@/components/ui/watercolor-bg";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { buttonPrimary } from "@/components/ui/surface";
import { USE_MOCK, api } from "@/lib/api";
import { resetMockData } from "@/lib/api/mock";
import { boardToMarkdown } from "@/lib/board-markdown";
import { useBoard } from "@/lib/use-board";
import { useTeam } from "@/lib/team";
import { useRepo } from "@/lib/use-repo";
import { cn } from "@/lib/utils";
import { Sentences } from "@/components/ui/sentences";

// 피그마 6번: 팀 결정 기록 보드 (176:2 레포 미연결 · 182:2 연결 후).
// 세 열: 왼쪽 브랜치·세부 주제 필터 · 가운데 결정 타임라인 + 이전 결정 이력 · 오른쪽 할 일 + 팀 목표·범위·규칙 + 조사·참고 (사용자 결정 11/15).
// '팀 상태 파일'(SYNCUP.md)은 예전 '팀 기록' 탭을 별도 화면(/board/record, 피그마 7-2·7-3)으로 옮겼다
export default function BoardPage() {
  const { load, refresh, reload } = useBoard();
  const repo = useRepo();
  const team = useTeam();
  const [topic, setTopic] = useState<string | null>(null); // 왼쪽 세부 주제 필터
  const [branch, setBranch] = useState<string | null>(null); // 브랜치 필터 (syncup.json by_branch 가 있을 때)
  const [dialog, setDialog] = useState(false);
  const [view, setView] = useState<BoardView>("carousel"); // 결정 보기: 기본 회전 보기 (폰 너비·움직임 줄이기면 목록만)
  const listOnly = useListOnly();

  if (load.state !== "ready") {
    return <Shell>{load.state === "loading" ? <LoadingState /> : <ErrorState message={load.message} onRetry={reload} />}</Shell>;
  }

  const { cards, conflicts, done } = load;
  const { todoIds, savedDecisions } = repoIndex(repo.state);
  // 브랜치를 고르면 그 브랜치 관련 결정·할 일만 남긴다 (조사·참고는 그대로)
  const match = branchMatcher(repo.state, branch, todoIds);
  const visible = match
    ? cards.filter((c) => (c.tag === "decision" ? match.decision(c) : c.tag === "todo" ? match.todo(c) : true))
    : cards;
  const { decisions, todos, research, topics, lastUpdate } = boardSections(visible);
  const shown = topic ? decisions.filter((c) => topicOf(c) === topic) : decisions;
  // 새 결정(cardB) id → 알림 단계와 바뀌기 전 결정 ('변경됨 · 이전: …' 표시용)
  const flagged = new Map<string, Flag>(conflicts.map((x) => [x.cardB.id, { level: alertLevel(x), previous: x.cardA.content }]));
  // 팀 기준: 목업은 팀 만들기에서 적은 값, 실제 모드는 팀 서버가 레포의 syncup.json team 에 넣은 값

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
      <PageTitle
        display="What we decided."
        title="팀 결정 기록"
        actions={
          <>
            {/* 피그마 182:40: 흰 바탕 · 테두리 rgba(24,23,58,0.14) · 높이 41 · 글자 13px */}
            <Link
              href="/board/record"
              className="inline-flex h-[41px] items-center gap-1.5 rounded-md border border-foreground/14 bg-white px-4 text-[13px] font-medium hover:bg-surface-soft"
            >
              <FileText className="size-[15px]" aria-hidden />
              팀 상태 파일
            </Link>
            <button type="button" onClick={copyRecord} disabled={!cards.length} className={cn(buttonPrimary, "gap-2")}>
              <Copy />
              팀 기록 복사
            </button>
          </>
        }
      >
        <span className="text-sm">
          결정 {decisions.length}개 · 할 일 {todos.length}개{lastUpdate > 0 && ` · 마지막 업데이트 ${fmtMDHM(new Date(lastUpdate))}`}
        </span>
      </PageTitle>
      {load.stale && (
        <p role="status" className="rounded-[12px] border border-alert-review-dot/50 bg-alert-review-soft px-4 py-2 text-sm text-alert-review">
          <Sentences>{"연결이 잠시 끊겼어요. 마지막으로 받은 기록을 보여 주고 있고, 다시 연결되면 자동으로 새로 고쳐요."}</Sentences>
        </p>
      )}
      <DecisionHistoryList />
      <ConflictChecks cards={cards} onRetry={retryCheck} />
      {conflicts.length > 0 && <ConflictBanner conflicts={conflicts} onOpen={() => setDialog(true)} />}
      <RepoStatusBar status={repo.status} unreachable={repo.unreachable} />

      <div className="grid items-start gap-5 lg:grid-cols-[180px_minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <BranchFilter branches={branchNames(repo.state)} value={match ? branch : null} members={match?.members} onChange={setBranch} />
          <TopicFilter topics={topics} total={decisions.length} active={topic} onChange={setTopic} />
        </div>
        <div className="min-w-0 space-y-4">
          {!cards.length ? (
            <EmptyState title="아직 팀에 올라온 결정이 없어요">
              <p>승인함에서 내용을 골라 올리면 여기에 쌓여요.</p>
            </EmptyState>
          ) : (
            <>
              {!listOnly && <BoardViewToggle value={view} onChange={setView} />}
              {view === "carousel" && !listOnly ? (
                <DecisionCarousel decisions={shown} flagged={flagged} onOpenConflict={() => setDialog(true)} />
              ) : (
                <DecisionTimeline
                  decisions={shown}
                  flagged={flagged}
                  saved={savedDecisions}
                  repoLinked={!!repo.status?.linked}
                  onOpenConflict={() => setDialog(true)}
                />
              )}
            </>
          )}
          <DecisionHistoryList />
        </div>
        <div className="space-y-5">
          <TodoPanel todos={todos} done={done} todoIds={todoIds} onToggle={toggleTodo} />
          {research.length > 0 && <ResearchPanel research={research} />}
        </div>
      </div>

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

// 피그마 본문: 폭 1280 화면에서 좌우 40 · 위 32 (내용 폭 1200)
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[calc(100dvh-4rem)] overflow-hidden">
      <WatercolorBg />
      <div className="relative mx-auto max-w-[1280px] space-y-5 px-gutter py-8 sm:px-10">{children}</div>
    </div>
  );
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
