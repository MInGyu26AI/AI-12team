// CLAUDE.md §6 화면 규칙: 표시 이름, 배지 색, 배지 판정. 웹·확장 공용.
// 색 값은 shared/theme.css 토큰. Tailwind 가 이 파일의 클래스를 읽도록 각 프로젝트 CSS 에 @source 로 등록.
import type { MessageSite } from "./bridge";
import type { Card, Conflict, RelatedCard, Resolution, Tag } from "./types";

export const TAG_LABEL: Record<Tag, string> = {
  decision: "결정",
  todo: "할 일",
  research: "조사",
  none: "제안",
};

// 개인·제안 배지 색. 문자열로 따로 둬서 isShareable 만 쓰는 확장 번들에 TAG_COLOR 표가 남지 않게 한다
export const PERSONAL_COLOR = "bg-tag-personal-soft text-tag-personal border-transparent";

export const TAG_COLOR: Record<Tag, string> = {
  decision: "bg-tag-decision-soft text-tag-decision border-tag-decision/20",
  todo: "bg-tag-todo-soft text-tag-todo border-tag-todo/20",
  research: "bg-tag-research-soft text-tag-research border-tag-research/20",
  none: PERSONAL_COLOR,
};

// 승인함 카드 테두리 (피그마 4번: 결정 남색 · 할 일 주황 · 조사 초록)
export const TAG_BORDER: Record<Tag, string> = {
  decision: "border-tag-decision/70",
  todo: "border-tag-todo/70",
  research: "border-tag-research/70",
  none: "border-border",
};

// 발화 출처 (최근 수집 묶음·분석에서 제외된 발화). 카드 출처 이름(ai/syncup_ai/classify.py SITE_LABEL)과 같다
export const SITE_LABEL: Record<MessageSite, string> = {
  chatgpt: "ChatGPT",
  manual: "직접 입력",
  "chatgpt-export": "ChatGPT 내보내기",
  codex: "Codex",
  "claude-code": "Claude Code",
};

// 팀 보드 충돌 알림 3단계. 확신도 0.6 미만(또는 서버가 '확인 필요'로 판정)이면 판정과 상관없이 '확인 필요'
export type AlertLevel = "conflict" | "review" | "change";

export function alertLevel(x: Pick<Conflict, "judgement" | "confidence">): AlertLevel {
  if ((x.confidence !== undefined && x.confidence < LOW_CONFIDENCE) || (x.judgement as string) === "확인 필요") return "review";
  return x.judgement === "변경" ? "change" : "conflict";
}

export const ALERT_LEVEL: Record<AlertLevel, { label: string; badge: string; card: string; banner: string; text: string; button: string }> = {
  conflict: {
    label: "충돌",
    badge: "bg-alert-conflict-soft text-alert-conflict",
    card: "border border-alert-conflict/50 bg-alert-conflict-soft/40",
    banner: "border-alert-conflict/40 bg-alert-conflict-soft",
    text: "text-alert-conflict",
    button: "bg-alert-conflict hover:bg-alert-conflict/90",
  },
  review: {
    label: "확인 필요",
    badge: "bg-alert-review-soft text-alert-review",
    card: "border border-alert-review/50 bg-alert-review-soft/40",
    banner: "border-alert-review/40 bg-alert-review-soft",
    text: "text-alert-review",
    button: "bg-alert-review hover:bg-alert-review/90",
  },
  change: {
    label: "변경",
    badge: "bg-alert-change-soft text-alert-change",
    card: "border border-alert-change/50 bg-alert-change-soft/40",
    banner: "border-alert-change/40 bg-alert-change-soft",
    text: "text-alert-change",
    button: "bg-alert-change hover:bg-alert-change/90",
  },
};

// 배너 색·요약 순서 (심한 것부터)
export const ALERT_ORDER: AlertLevel[] = ["conflict", "review", "change"];

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

// 후보를 만든 방법 (ai/syncup_ai: chat = 대화 분류, decisions = Decisions API 판별, manual = 옛 로컬 승인 카드, card_contract.board_card)
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
