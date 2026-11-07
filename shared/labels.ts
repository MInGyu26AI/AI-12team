// CLAUDE.md §6 화면 규칙: 표시 이름, 배지 색, 배지 판정. 웹·확장 공용.
// Tailwind 가 이 파일의 클래스를 읽도록 각 프로젝트 CSS 에 @source 로 등록돼 있음.
import type { Card, Relevance, Tag } from "./types";

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

export const BADGE_COLOR = {
  relevance: "bg-green-100 text-green-800 border-green-200", // 관련성=초록
  subtopic: "bg-purple-100 text-purple-800 border-purple-200", // 소주제=보라
  tag: "bg-blue-100 text-blue-800 border-blue-200", // 표시=파랑
  masked: "bg-red-100 text-red-800 border-red-200", // 민감정보=빨강
  lowConfidence: "bg-amber-100 text-amber-800 border-amber-200",
  change: "bg-orange-100 text-orange-800 border-orange-200",
} as const;

export const LOW_CONFIDENCE = 0.6;

// 개인 검토함에서 기본으로 숨기거나 회색 처리할 카드
export const isDimmed = (c: Card) => c.relevance === "personal" || c.tag === "none";

// 상태 배지 목록 (순서 = 표시 순서)
export function statusBadges(c: Card) {
  const badges: { label: string; color: string }[] = [];
  if (c.confidence < LOW_CONFIDENCE) badges.push({ label: "확인 필요", color: BADGE_COLOR.lowConfidence });
  if (c.masked) badges.push({ label: "민감정보 가림", color: BADGE_COLOR.masked });
  if (c.is_change && c.tag === "decision") badges.push({ label: "변경", color: BADGE_COLOR.change });
  return badges;
}
