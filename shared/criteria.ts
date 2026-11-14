// 프로젝트 방향성 기준 (2차 최종 회의): 팀 목표 · 범위 · 규칙. 모두 선택 입력.
// AI 분류(ai/syncup_ai/classify.py _team_criteria)가 teamGoal · teamScope · teamRules 를 받는다.
// 로컬 수집기 collection.configure 는 아직 이 값을 받지 않아(collector/collection_settings.py CONFIGURABLE) 확장·웹에만 저장한다
export interface TeamCriteria {
  teamGoal?: string;
  teamScope?: string;
  teamRules?: string[];
}

/** 규칙 입력칸(한 줄에 하나) → 목록 */
export const rulesFromText = (text: string) =>
  text
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);

/** 빈 값을 뺀 기준. 아무것도 없으면 undefined */
export function cleanCriteria(c: { teamGoal?: string; teamScope?: string; teamRules?: string[] }): TeamCriteria | undefined {
  const out: TeamCriteria = {};
  if (c.teamGoal?.trim()) out.teamGoal = c.teamGoal.trim();
  if (c.teamScope?.trim()) out.teamScope = c.teamScope.trim();
  const rules = (c.teamRules ?? []).map((r) => r.trim()).filter(Boolean);
  if (rules.length) out.teamRules = rules;
  return Object.keys(out).length ? out : undefined;
}

/** syncup.json 의 team(goal · scope · rules) → 기준 */
export const criteriaFromState = (team?: { goal?: string; scope?: string; rules?: string[] }) =>
  team ? cleanCriteria({ teamGoal: team.goal, teamScope: team.scope, teamRules: team.rules }) : undefined;
