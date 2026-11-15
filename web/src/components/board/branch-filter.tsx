import { GitBranch } from "lucide-react";
import { card, input } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 팀 보드 '브랜치' 필터: 레포 syncup.json 에 by_branch 가 있을 때만. 고른 브랜치 관련 결정·할 일만 보인다.
// 피그마 6번에 없는 기존 기능이라 왼쪽 열 세부 주제 필터 위에 같은 카드 모양으로 둔다 (사용자 결정 11/15)
export function BranchFilter({ branches, value, members, onChange }: {
  branches: string[];
  value: string | null;
  members?: string[]; // 고른 브랜치의 커밋 작성자
  onChange: (branch: string | null) => void;
}) {
  if (!branches.length) return null;
  return (
    <div className={cn(card, "space-y-2 p-[13px] text-sm")}>
      <label htmlFor="branch-filter" className="flex items-center gap-1.5 font-medium">
        <GitBranch className="size-4 text-muted-foreground" aria-hidden />
        브랜치
      </label>
      <select id="branch-filter" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={cn(input, "h-9")}>
        <option value="">전체</option>
        {branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      {value && (
        <p className="text-xs text-muted-foreground break-keep">
          관련 결정·할 일만 보여요{members?.length ? ` · 참여 ${members.join(", ")}` : ""}
        </p>
      )}
    </div>
  );
}
