// CLAUDE.md §6 화면 규칙: 표시 이름, 배지 색, 배지 판정. 웹·확장 공용.
// 색 값은 shared/theme.css 토큰. Tailwind 가 이 파일의 클래스를 읽도록 각 프로젝트 CSS 에 @source 로 등록.
import type { Card, Judgement, RelatedCard, Resolution, Tag } from "./types";

export const TAG_LABEL: Record<Tag, string> = {
  decision: "결정",
  todo: "할 일",
  research: "조사",
  none: "제안",
};

export const TAG_COLOR: Record<Tag, string> = {
  decision: "bg-tag-decision-soft text-tag-decision border-tag-decision/20",
  todo: "bg-tag-todo-soft text-tag-todo border-tag-todo/20",
  research: "bg-tag-research-soft text-tag-research border-tag-research/20",
  none: "bg-tag-personal-soft text-tag-personal border-transparent",
};

// 승인함 카드 테두리 (피그마 4번: 결정 남색 · 할 일 주황 · 조사 초록)
export const TAG_BORDER: Record<Tag, string> = {
  decision: "border-tag-decision/70",
  todo: "border-tag-todo/70",
  research: "border-tag-research/70",
  none: "border-border",
};
export const PERSONAL_COLOR = TAG_COLOR.none;

// 충돌 판정 배지 (변경도 경고로 보여 주되 색으로 구분)
export const JUDGEMENT_COLOR: Record<Judgement, string> = {
  충돌: "bg-sensitive-soft text-sensitive",
  변경: "bg-change-soft text-change",
  같음: "bg-muted text-muted-foreground",
  무관: "bg-muted text-muted-foreground",
};

// 충돌 처리 이력 (팀 서버 conflicts/history). obsolete = 관련 결정이 다른 처리로 끝나 함께 닫힘
export const RESOLUTION_LABEL: Record<Resolution | "obsolete", string> = {
  "adopt-new": "새 결정 채택",
  "keep-existing": "기존 유지",
  "both-valid": "둘 다 유효",
  discuss: "논의 요청",
  obsolete: "관련 결정 종료",
};

// 충돌 처리로 보드에서 내려간 결정 (active·review 는 보드에 남아 있어 이름이 없다)
export const DECISION_STATE_LABEL: Partial<Record<NonNullable<RelatedCard["decisionState"]>, string>> = {
  superseded: "새 결정으로 대체됨",
  rejected: "기존 결정 유지로 미채택",
};

// 후보를 만든 방법 (ai/syncup_ai: chat = 대화 분류, decisions = Decisions API 판별, manual = 팀 보드에 직접 입력)
export const CLASSIFICATION_METHOD_LABEL: Record<NonNullable<RelatedCard["classificationMethod"]>, string> = {
  chat: "AI 대화 분류",
  decisions: "AI 결정 판별",
  manual: "직접 입력",
};

const BADGE_COLOR = {
  masked: "bg-sensitive-soft text-sensitive border-sensitive/20", // 민감정보=빨강
  lowConfidence: "bg-warn-soft text-warn border-warn/20",
  change: "bg-change-soft text-change border-change/20",
} as const;

export const LOW_CONFIDENCE = 0.6;

// 팀 보드·공유 후보에 올라갈 수 있는 카드 (관련 + 제안 아님)
export const isShareable = (c: Card): c is RelatedCard => c.relevance === "related" && c.tag !== "none";

// 상태 배지 목록 (순서 = 표시 순서)
export function statusBadges(c: Card) {
  const badges: { label: string; color: string }[] = [];
  if (c.confidence < LOW_CONFIDENCE) badges.push({ label: "확인 필요", color: BADGE_COLOR.lowConfidence });
  if (c.masked) badges.push({ label: "민감정보 가림", color: BADGE_COLOR.masked });
  if (c.relevance === "related" && c.is_change && c.tag === "decision") badges.push({ label: "변경", color: BADGE_COLOR.change });
  return badges;
}
