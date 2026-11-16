"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { ONBOARDING_SKIP_KEY as SKIP_KEY } from "@/components/dashboard/create-team-dialog";
import { useDashboard } from "@/components/dashboard/context";
import { PcBanner } from "@/components/dashboard/pc-required";
import { TeamSwatch } from "@/components/dashboard/team-swatch";
import { PageTitle } from "@/components/page-title";
import { card } from "@/components/ui/surface";
import { api, USE_MOCK } from "@/lib/api";
import { useCollectorStatus } from "@/lib/local-collector";
import { useTeam } from "@/lib/team";
import { cn } from "@/lib/utils";

type Counts = { decisions: number; todos: number; conflicts: number };

// 로그인 후 첫 화면 (손그림 대시보드): 내 팀 카드 + 새 팀 카드. PC가 연결되지 않았으면 맨 위에 연결 띠.
// 팀 기록 숫자는 이 PC가 연결된 팀만 읽을 수 있다 (팀 기록은 이 PC의 수집기를 거쳐 팀 서버에서 온다)
export default function DashboardPage() {
  const { account, pc, openCreateTeam } = useDashboard();
  const team = useTeam();
  const { status } = useCollectorStatus();
  const counts = useLinkedCounts(pc.kind === "ok" || USE_MOCK); // 목업은 예시 팀 기록을 브라우저 안에서 읽는다

  const teams = account
    ? account.teams.map((t) => {
        const linked = t.id === status?.teamId;
        return { id: t.id, name: t.name, topic: linked ? status?.projectTopic ?? "" : "", linked };
      })
    : USE_MOCK ? [{ id: team.code || "demo", name: team.name, topic: team.topic, linked: true }] : [];

  // 처음 로그인(팀이 없음): 팀 만들기 팝업을 한 번 띄운다. 건너뛰면 이 브라우저에서는 다시 띄우지 않는다
  const noTeams = !!account && account.teams.length === 0;
  useEffect(() => {
    if (!noTeams) return;
    let skipped = false;
    try { skipped = localStorage.getItem(SKIP_KEY) === "1"; } catch { /* 저장소를 못 쓰면 매번 띄운다 */ }
    if (!skipped) openCreateTeam();
  }, [noTeams, openCreateTeam]);

  return (
    <div className="mx-auto max-w-[1120px] space-y-6 px-gutter py-8 md:px-8">
      <PageTitle display="Your teams." title="내 팀">팀을 고르면 그 팀의 결정 기록과 승인함이 열려요</PageTitle>
      <PcBanner />
      <section aria-label="내 팀 목록" className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-4">
        {teams.map((t, i) => (
          <TeamCard key={t.id} index={i} name={t.name} topic={t.topic} linked={t.linked} counts={t.linked ? counts : null} />
        ))}
        <button
          type="button"
          onClick={openCreateTeam}
          className="flex min-h-44 flex-col items-center justify-center gap-2 border border-dashed border-ink/25 text-sm text-ink-2 hover:bg-white/60"
        >
          <Plus aria-hidden className="size-5 text-ink" />새 팀 만들기
        </button>
      </section>
      {!USE_MOCK && (
        <p className="text-sm text-muted-foreground">팀원에게 초대받았다면 받은 초대 링크를 열어 참여하세요.</p>
      )}
    </div>
  );
}

function TeamCard({ index, name, topic, linked, counts }: { index: number; name: string; topic: string; linked: boolean; counts: Counts | null }) {
  const body = (
    <>
      <div className="flex items-center gap-3">
        <TeamSwatch index={index} className="size-11" />
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-ink">{name}</p>
          {topic && <p className="mt-1 truncate text-[13px] text-ink-2">{topic}</p>}
        </div>
      </div>
      {linked ? (
        counts && (
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-body">
            <span>결정 <span className="font-mono tabular-nums">{counts.decisions}</span></span>
            <span aria-hidden className="text-ink/25">·</span>
            <span>할 일 <span className="font-mono tabular-nums">{counts.todos}</span></span>
            {counts.conflicts > 0 && <span className="ml-1 bg-flare px-2 py-0.5 text-xs font-medium text-ink">충돌 {counts.conflicts}</span>}
          </p>
        )
      ) : (
        <p className="text-[13px] leading-normal break-keep text-ink-3">이 PC는 다른 팀에 연결돼 있어요. SyncUp 앱에서 팀을 바꾸면 기록이 보여요.</p>
      )}
      <p className="mt-auto flex items-center justify-end text-[13px] font-medium text-ink">{linked ? "팀 결정 기록 열기 →" : ""}</p>
    </>
  );
  const box = cn(card, "flex min-h-44 flex-col gap-4 bg-white/70 p-5");
  return linked ? <Link href="/board" className={cn(box, "hover:bg-white")}>{body}</Link> : <div className={box}>{body}</div>;
}

/** 이 PC가 연결된 팀의 결정·할 일·미해결 충돌 수. 연결되지 않았으면 읽지 않는다 */
function useLinkedCounts(enabled: boolean): Counts | null {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.all([api.getBoard(), api.getConflicts()]).then(([cards, conflicts]) => {
      if (cancelled) return;
      setCounts({
        decisions: cards.filter((c) => c.tag === "decision").length,
        todos: cards.filter((c) => c.tag === "todo").length,
        conflicts: conflicts.length,
      });
    }).catch(() => { /* 숫자는 보조 정보라 실패하면 줄을 숨긴다 */ });
    return () => { cancelled = true; };
  }, [enabled]);
  return enabled ? counts : null;
}
