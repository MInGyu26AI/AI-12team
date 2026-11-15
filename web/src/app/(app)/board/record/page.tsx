"use client";

import { TeamRecord } from "@/components/board/team-record";
import { ErrorState, LoadingState } from "@/components/states";
import { useBoard } from "@/lib/use-board";
import { useRepo } from "@/lib/use-repo";
import { useTeam } from "@/lib/team";

// 피그마 7-2·7-3: 팀 상태 파일 (팀 결정 기록의 '팀 상태 파일' 버튼으로 연다)
export default function TeamRecordPage() {
  const { load, reload } = useBoard();
  const repo = useRepo();
  const team = useTeam();
  if (load.state !== "ready") {
    return (
      <div className="mx-auto max-w-[1280px] px-gutter py-8 sm:px-10">
        {load.state === "loading" ? <LoadingState /> : <ErrorState message={load.message} onRetry={reload} />}
      </div>
    );
  }
  return <TeamRecord status={repo.status} cards={load.cards} conflicts={load.conflicts} done={load.done} teamName={team.name} />;
}
