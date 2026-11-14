import { TriangleAlert } from "lucide-react";
import { ALERT_LEVEL, ALERT_ORDER, alertLevel } from "@shared/labels";
import type { Conflict } from "@shared/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 보드 맨 위 충돌 배너 → '확인하기'로 충돌 모달 (피그마 6번). 색은 가장 심한 단계(충돌 > 확인 필요 > 변경)
export function ConflictBanner({ conflicts, onOpen }: { conflicts: Conflict[]; onOpen: () => void }) {
  const levels = conflicts.map(alertLevel);
  const tone = ALERT_LEVEL[ALERT_ORDER.find((l) => levels.includes(l)) ?? "conflict"];
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-xl border px-5 py-4", tone.banner)}>
      <TriangleAlert className={cn("size-5 shrink-0", tone.text)} />
      <p className={cn("min-w-0 flex-1 font-semibold break-keep", tone.text)}>{summary(conflicts, levels)}, 팀 논의가 필요해요</p>
      <Button className={cn("h-10 px-5 text-white", tone.button)} onClick={onOpen}>
        확인하기
      </Button>
    </div>
  );
}

// "충돌 1건: MVP 범위" / "충돌 1건 · 확인 필요 1건 · 변경 1건: MVP 범위, 회의 시간"
function summary(conflicts: Conflict[], levels: ReturnType<typeof alertLevel>[]) {
  const counts = ALERT_ORDER.map((l) => [l, levels.filter((x) => x === l).length] as const)
    .filter(([, n]) => n)
    .map(([l, n]) => `${ALERT_LEVEL[l].label} ${n}건`)
    .join(" · ");
  return `${counts}: ${[...new Set(conflicts.map((x) => x.topic_key))].join(", ")}`;
}
