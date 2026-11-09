"use client";

import { Button } from "@/components/ui/button";

// 승인함 하단 고정 바 (피그마: "4개 선택됨 · 개인 1개 제외 [전체 해제] [선택한 4개 팀에 올리기]")
export function ShareBar({ selected, personal, canSelect, allSelected, sharing, onToggleAll, onShare }: {
  selected: number;
  personal: number;
  canSelect: boolean; // 공유 후보가 하나라도 있는지
  allSelected: boolean;
  sharing: boolean;
  onToggleAll: () => void;
  onShare: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 px-gutter pb-4">
      <div className="mx-auto flex max-w-content flex-wrap items-center gap-3 rounded-xl border bg-background px-5 py-3 shadow-lg">
        <p className="text-sm text-muted-foreground">
          {selected}개 선택됨{personal > 0 && ` · 개인 ${personal}개 제외`}
        </p>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" className="h-10" disabled={!canSelect} onClick={onToggleAll}>
            {allSelected ? "전체 해제" : "전체 선택"}
          </Button>
          <Button className="h-10 bg-brand px-4 hover:bg-brand-hover" disabled={!selected || sharing} onClick={onShare}>
            {sharing ? "올리는 중…" : `선택한 ${selected}개 팀에 올리기`}
          </Button>
        </div>
      </div>
    </div>
  );
}
