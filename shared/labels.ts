// CLAUDE.md §6 화면 규칙: 표시 이름, 배지 색, 배지 판정. 웹·확장 공용.
// 색 값은 shared/theme.css 토큰. Tailwind 가 이 파일의 클래스를 읽도록 각 프로젝트 CSS 에 @source 로 등록.
import type { Card, RelatedCard, Relevance, Tag } from "./types";

export const TAG_LABEL: Record<Tag, string> = {
  decision: "결정",
  todo: "할 일",
  research: "조사",
  none: "제안",
};

export const RELEVANCE_LABEL: Record<Relevance, string> = {
  related: "팀 관련",
  personal: "개인",
};

export const TAG_COLOR: Record<Tag, string> = {
  decision: "bg-tag-decision-soft text-tag-decision border-tag-decision/20",
  todo: "bg-tag-todo-soft text-tag-todo border-tag-todo/20",
  research: "bg-tag-research-soft text-tag-research border-tag-research/20",
  none: "bg-muted text-muted-foreground border-border",
};

export const BADGE_COLOR = {
  relevance: "bg-relevance-soft text-relevance border-relevance/20", // 관련성=초록
  subtopic: "bg-subtopic-soft text-subtopic border-subtopic/20", // 소주제=보라
  masked: "bg-sensitive-soft text-sensitive border-sensitive/20", // 민감정보=빨강
  lowConfidence: "bg-warn-soft text-warn border-warn/20",
  change: "bg-change-soft text-change border-change/20",
} as const;

export const LOW_CONFIDENCE = 0.6;

// 개인 검토함에서 기본으로 숨기거나 회색 처리할 카드
export const isDimmed = (c: Card) => c.relevance === "personal" || c.tag === "none";

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
