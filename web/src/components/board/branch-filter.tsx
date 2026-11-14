import { GitBranch } from "lucide-react";

// 팀 보드 '브랜치' 필터: 레포 syncup.json 에 by_branch 가 있을 때만. 고른 브랜치 관련 결정·할 일만 보인다
export function BranchFilter({ branches, value, members, onChange }: {
  branches: string[];
  value: string | null;
  members?: string[]; // 고른 브랜치의 커밋 작성자
  onChange: (branch: string | null) => void;
}) {
  if (!branches.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <GitBranch className="size-4 text-muted-foreground" />
      <label htmlFor="branch-filter" className="font-medium">
        브랜치
      </label>
      <select
        id="branch-filter"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 rounded-lg border bg-background px-2.5"
      >
        <option value="">전체</option>
        {branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      {value && <span className="text-muted-foreground">관련 결정·할 일만 보여요{members?.length ? ` · 참여 ${members.join(", ")}` : ""}</span>}
    </div>
  );
}
