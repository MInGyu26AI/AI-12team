import { TriangleAlert } from "lucide-react";
import type { Conflict, Judgement } from "@shared/types";
import { Button } from "@/components/ui/button";

// 보드 맨 위 충돌 배너 → '확인하기'로 충돌 모달 (피그마 6번)
export function ConflictBanner({ conflicts, onOpen }: { conflicts: Conflict[]; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sensitive/40 bg-sensitive-soft px-5 py-4">
      <TriangleAlert className="size-5 shrink-0 text-sensitive" />
      <p className="min-w-0 flex-1 font-semibold text-sensitive break-keep">{summary(conflicts)}, 팀 논의가 필요해요</p>
      <Button className="h-10 bg-sensitive px-5 text-white hover:bg-sensitive/90" onClick={onOpen}>
        확인하기
      </Button>
    </div>
  );
}

// "충돌 1건: MVP 범위" / "충돌 1건 · 변경 1건: MVP 범위, 회의 시간"
function summary(conflicts: Conflict[]) {
  const n = (j: Judgement) => conflicts.filter((x) => x.judgement === j).length;
  const counts = [n("충돌") && `충돌 ${n("충돌")}건`, n("변경") && `변경 ${n("변경")}건`].filter(Boolean).join(" · ");
  return `${counts}: ${[...new Set(conflicts.map((x) => x.topic_key))].join(", ")}`;
}
