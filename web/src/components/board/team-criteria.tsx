import { Target } from "lucide-react";
import type { TeamCriteria } from "@shared/criteria";

// 팀 보드 맨 위에 고정하는 팀 목표·범위·규칙 (프로젝트 방향성 기준). 하나도 없으면 숨긴다
export function TeamCriteriaCard({ criteria }: { criteria?: TeamCriteria }) {
  if (!criteria) return null;
  const { teamGoal, teamScope, teamRules } = criteria;
  return (
    <section className="space-y-1.5 rounded-xl border border-brand/20 bg-brand-soft/60 px-5 py-4 text-sm" aria-label="팀 기준">
      <p className="flex items-center gap-1.5 font-semibold text-brand">
        <Target className="size-4" />
        팀 기준
      </p>
      {teamGoal && <p className="break-keep"><b>목표</b> · {teamGoal}</p>}
      {teamScope && <p className="break-keep"><b>범위</b> · {teamScope}</p>}
      {teamRules && (
        <ul className="list-disc space-y-0.5 pl-5 break-keep">
          {teamRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
