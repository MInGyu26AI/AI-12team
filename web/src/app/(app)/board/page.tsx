"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Copy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { fmtDue, fmtHM, fmtMD, fmtMDHM, parseSource, timeOf } from "@shared/format";
import { JUDGEMENT_COLOR } from "@shared/labels";
import type { Conflict, Judgement, RelatedCard } from "@shared/types";
import { Avatar } from "@/components/avatar";
import { ConflictDialog } from "@/components/conflict-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { USE_MOCK, api } from "@/lib/api";
import { resetMockData } from "@/lib/api/mock";
import { boardToMarkdown } from "@/lib/record";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; cards: RelatedCard[]; conflicts: Conflict[]; done: Set<string> };

const newestFirst = (a: RelatedCard, b: RelatedCard) => timeOf(b.source) - timeOf(a.source);

// 피그마 6번: 팀 결정 기록 보드
export default function BoardPage() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [topic, setTopic] = useState<string | null>(null); // 왼쪽 세부 주제 필터
  const [dialog, setDialog] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cards, conflicts, done] = await Promise.all([api.getBoard(), api.getConflicts(), api.getDoneTodos()]);
      setLoad({ state: "ready", cards, conflicts, done: new Set(done) });
    } catch (e) {
      setLoad({ state: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 마운트 시 서버에서 한 번 불러옴
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (load.state === "loading")
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  if (load.state === "error")
    return (
      <Shell>
        <ErrorState
          message={load.message}
          onRetry={() => {
            setLoad({ state: "loading" });
            refresh();
          }}
        />
      </Shell>
    );

  const { cards, conflicts, done } = load;
  const decisions = cards.filter((c) => c.tag === "decision").sort(newestFirst);
  const todos = cards
    .filter((c) => c.tag === "todo")
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || timeOf(a.source) - timeOf(b.source));
  const research = cards.filter((c) => c.tag === "research").sort(newestFirst);
  const topics = [...Map.groupBy(decisions, (c) => c.topic_key ?? "기타")].map(([k, v]) => ({ key: k, count: v.length }));
  const shown = topic ? decisions.filter((c) => (c.topic_key ?? "기타") === topic) : decisions;
  const flagged = new Map<string, Judgement>(conflicts.map((x) => [x.cardB.id, x.judgement]));
  const last = cards.reduce((m, c) => Math.max(m, timeOf(c.source)), 0);

  const copyRecord = async () => {
    try {
      await navigator.clipboard.writeText(boardToMarkdown(cards, conflicts));
      toast.success("복사됨! ChatGPT나 Claude에 붙여넣으세요");
    } catch {
      toast.error("클립보드 복사에 실패했어요. 브라우저 권한을 확인해 주세요");
    }
  };

  const toggleTodo = async (id: string, on: boolean) => {
    try { await api.setTodoDone(id, on); await refresh(); }
    catch { toast.error("저장하지 못했어요"); }
  };

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">팀 결정 기록</h1>
          <p className="text-muted-foreground">
            결정 {decisions.length}개 · 할 일 {todos.length}개{last > 0 && ` · 마지막 업데이트 ${fmtMDHM(new Date(last))}`}
          </p>
        </div>
        <Button onClick={copyRecord} disabled={!cards.length} className="h-11 bg-brand px-5 hover:bg-brand-hover">
          <Copy />
          팀 기록 복사
        </Button>
      </div>
      {!USE_MOCK && <History />}
      {cards.filter(c => ['pending','running','failed'].includes(c.conflictCheckStatus ?? '')).map(c => <div key={c.id} className="rounded border p-3"><span>{c.content} · {c.conflictCheckDetail || (c.conflictCheckStatus === 'failed' ? 'AI 검사 미완료 · 확인 필요' : '기존 결정과 비교 중')}{c.conflictCheckStatus === 'failed' && ' · 충돌 없음으로 확정되지 않음'}</span>{c.conflictCheckStatus === 'failed' && <Button variant="outline" onClick={async () => { try { await rpc('team.retryCheck', { id: c.id }); await refresh(); } catch (error) { toast.error((error as Error).message); } }}>검사 재시도</Button>}</div>)}

      {conflicts.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sensitive/40 bg-sensitive-soft px-5 py-4">
          <TriangleAlert className="size-5 shrink-0 text-sensitive" />
          <p className="min-w-0 flex-1 font-semibold text-sensitive break-keep">
            {summary(conflicts)}, 팀 논의가 필요해요
          </p>
          <Button className="h-10 bg-sensitive px-5 text-white hover:bg-sensitive/90" onClick={() => setDialog(true)}>
            확인하기
          </Button>
        </div>
      )}

      {!cards.length ? (
        <EmptyState title="아직 팀에 올라온 결정이 없어요">
          <p>승인함에서 내용을 골라 올리면 여기에 쌓여요.</p>
        </EmptyState>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[200px_minmax(0,1fr)_300px]">
          {/* 왼쪽: 세부 주제 */}
          <nav className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-2 lg:flex-col lg:p-3" aria-label="세부 주제">
            <TopicButton label="전체" count={decisions.length} active={!topic} onClick={() => setTopic(null)} />
            {topics.map((t) => (
              <TopicButton key={t.key} label={t.key} count={t.count} active={topic === t.key} onClick={() => setTopic(t.key)} />
            ))}
          </nav>

          {/* 가운데: 결정 타임라인 */}
          <section className="rounded-xl border bg-card p-2" aria-label="결정">
            {shown.length ? (
              <ol className="divide-y">
                {shown.map((c) => (
                  <DecisionItem key={c.id} card={c} judgement={flagged.get(c.id)} onOpen={() => setDialog(true)} />
                ))}
              </ol>
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">이 주제의 결정이 없어요.</p>
            )}
          </section>

          {/* 오른쪽: 할 일 + 조사 */}
          <div className="space-y-5">
            <section className="rounded-xl border bg-card p-5" aria-label="할 일">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                할 일 <span className="rounded-full bg-tag-todo-soft px-2 text-sm text-tag-todo">{todos.length}</span>
              </h2>
              <ul className="mt-3 space-y-3">
                {todos.map((t) => (
                  <li key={t.id} className="flex gap-3">
                    <Checkbox
                      checked={done.has(t.id)}
                      onCheckedChange={(v) => toggleTodo(t.id, v === true)}
                      className="mt-0.5 size-5 data-checked:border-brand data-checked:bg-brand"
                      aria-label={`${t.content} 완료`}
                    />
                    <div className="min-w-0">
                      <p className={cn("font-medium break-keep", done.has(t.id) && "text-muted-foreground")}>{t.content}</p>
                      <p className="text-sm text-tag-todo">
                        {t.owner ?? "담당 미정"} · 기한 {t.due ? fmtDue(t.due) : "미정"}
                      </p>
                    </div>
                  </li>
                ))}
                {!todos.length && <li className="text-sm text-muted-foreground">할 일이 없어요.</li>}
              </ul>
            </section>

            {research.length > 0 && (
              <section className="rounded-xl border bg-card p-5" aria-label="조사">
                <h2 className="flex items-center gap-2 text-lg font-bold">
                  <BookOpen className="size-4 text-tag-research" />
                  조사·참고 <span className="rounded-full bg-tag-research-soft px-2 text-sm text-tag-research">{research.length}</span>
                </h2>
                <ul className="mt-3 space-y-3">
                  {research.map((r) => (
                    <li key={r.id} className="text-sm">
                      <p className="break-keep">{r.content}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.topic_key} · {parseSource(r.source).label}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
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

      {dialog && conflicts.length > 0 && (
        <ConflictDialog conflicts={conflicts} onClose={() => setDialog(false)} onResolved={refresh} />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-wide space-y-6 px-gutter py-10">{children}</div>;
}

function History() {
  const [records, setRecords] = useState<RelatedCard[]|null>(null);
  const [events, setEvents] = useState<{resolution:string;note:string;at:string}[]>([]);
  const load = async () => { try {
    const [history, log] = await Promise.all([rpc<{items:RelatedCard[]}>('team.history'), rpc<{events:typeof events}>('team.conflictHistory')]);
    setRecords(history.items); setEvents(log.events);
  } catch (error) { toast.error((error as Error).message); } };
  return <details className="rounded-xl border p-4" onToggle={e => e.currentTarget.open && void load()}><summary className="cursor-pointer">이전 결정과 처리 이력</summary>
    <ul className="mt-3 space-y-2">{records?.filter(c => c.decisionState === 'superseded' || c.decisionState === 'rejected').map(c => <li key={c.id}>{c.content} · {c.decisionState === 'superseded' ? '새 결정으로 대체됨' : '기존 결정 유지로 미채택'}</li>)}
    {events.map((e,i) => <li key={i}>{e.at} · {({'adopt-new':'새 결정 채택','keep-existing':'기존 유지','both-valid':'둘 다 유효',discuss:'논의 요청',obsolete:'관련 결정 종료'} as Record<string,string>)[e.resolution]} {e.note}</li>)}</ul></details>;
}

// "충돌 1건: MVP 범위" / "충돌 1건 · 변경 1건: MVP 범위, 회의 시간"
function summary(conflicts: Conflict[]) {
  const n = (j: Judgement) => conflicts.filter((x) => x.judgement === j).length;
  const counts = [n("충돌") && `충돌 ${n("충돌")}건`, n("변경") && `변경 ${n("변경")}건`].filter(Boolean).join(" · ");
  return `${counts}: ${[...new Set(conflicts.map((x) => x.topic_key))].join(", ")}`;
}

function TopicButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center justify-between gap-4 rounded-lg px-3.5 py-2.5 text-left whitespace-nowrap",
        active ? "bg-brand-soft font-semibold text-brand" : "hover:bg-muted",
      )}
    >
      {label}
      <span className={cn("text-sm", active ? "text-brand" : "text-muted-foreground")}>{count}</span>
    </button>
  );
}

function DecisionItem({ card: c, judgement, onOpen }: { card: RelatedCard; judgement?: Judgement; onOpen: () => void }) {
  const src = parseSource(c.source);
  return (
    <li
      className={cn(
        "grid grid-cols-[52px_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl p-4 sm:grid-cols-[72px_minmax(0,1fr)] sm:p-5",
        judgement && "border border-sensitive/50 bg-sensitive-soft/40",
      )}
    >
      <div className="text-sm">
        {src.at ? (
          <>
            <p className="font-semibold">{fmtMD(src.at)}</p>
            <p className="text-muted-foreground">{fmtHM(src.at)}</p>
          </>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {c.topic_key && <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">{c.topic_key}</span>}
          {judgement && (
            <button onClick={onOpen} className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", JUDGEMENT_COLOR[judgement])}>
              {judgement}
            </button>
          )}
        </div>
        <p className="text-lg font-bold break-keep">{c.content}</p>
        {c.reason && <p className="text-sm text-muted-foreground break-keep">이유: {c.reason}</p>}
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Avatar name={c.owner} size="sm" />
          {[c.owner, src.label].filter(Boolean).join(" · ")}
        </p>
      </div>
    </li>
  );
}
