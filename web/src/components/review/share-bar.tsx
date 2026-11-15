"use client";

import { buttonOutline, buttonPrimary, card } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 승인함 맨 아래 바 (피그마 4번 Action Bar 152:306: "4개 선택됨 · 개인 1개 제외 [전체 해제] [선택한 4개 팀에 올리기]").
// 피그마처럼 목록 끝에 두고, 목록이 길면 화면 아래에 붙어 따라온다 (sticky)
export function ShareBar({ selected, personal, canSelect, allSelected, sharing, onToggleAll, onShare }: {
  selected: number;
  personal: number;
  canSelect: boolean; // 고를 수 있는 후보(화자 확인이 필요 없는 카드)가 하나라도 있는지
  allSelected: boolean;
  sharing: boolean;
  onToggleAll: () => void;
  onShare: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-20">
      <div className={cn(card, "flex flex-wrap items-center gap-3 px-5 py-3.5 shadow-card")}>
        <p className="text-sm leading-[1.5] font-medium text-muted-foreground">
          {selected}개 선택됨{personal > 0 && ` · 개인 ${personal}개 제외`}
        </p>
        <div className="ml-auto flex gap-2.5">
          <button type="button" className={buttonOutline} disabled={!canSelect} onClick={onToggleAll}>
            {allSelected ? "전체 해제" : "전체 선택"}
          </button>
          <button type="button" className={buttonPrimary} disabled={!selected || sharing} onClick={onShare}>
            {sharing ? "올리는 중…" : `선택한 ${selected}개 팀에 올리기`}
          </button>
        </div>
      </div>
    </div>
  );
}
