import type { TeamCriteria } from "@shared/criteria";
import { card } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 팀 목표·범위·규칙 (프로젝트 방향성 기준). 하나도 없으면 숨긴다.
// 피그마 6번에 없는 기존 카드라 오른쪽 열 '할 일' 아래에 같은 카드 모양으로 둔다 (사용자 결정 11/15)
export function TeamCriteriaCard({ criteria }: { criteria?: TeamCriteria }) {
  if (!criteria) return null;
  const { teamGoal, teamScope, teamRules } = criteria;
  return (
    <section className={cn(card, "space-y-2 p-5 text-sm leading-[1.5]")} aria-label="팀 기준">
      <h2 className="text-lg font-medium">팀 목표·범위·규칙</h2>
      {teamGoal && (
        <p className="break-keep">
          <span className="text-muted-foreground">목표</span> · {teamGoal}
        </p>
      )}
      {teamScope && (
        <p className="break-keep">
          <span className="text-muted-foreground">범위</span> · {teamScope}
        </p>
      )}
      {teamRules && (
        <ul className="list-disc space-y-0.5 pl-5 break-keep marker:text-text-tertiary">
          {teamRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
