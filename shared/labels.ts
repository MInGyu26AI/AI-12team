// CLAUDE.md §6 화면 규칙: 표시 이름, 배지 색, 배지 판정. 웹·확장 공용.
// 색 값은 shared/theme.css 토큰. Tailwind 가 이 파일의 클래스를 읽도록 각 프로젝트 CSS 에 @source 로 등록.
import type { MessageSite } from "./bridge";
import { PRE_ALERT_HINT, PRE_ALERT_LABEL } from "./pre-alert";
import type { Card, Conflict, RelatedCard, Resolution, Tag } from "./types";

export const TAG_LABEL: Record<Tag, string> = {
  decision: "결정",
  todo: "할 일",
  research: "조사",
  none: "제안",
};

// 개인·제안 배지 색. 문자열로 따로 둬서 isShareable 만 쓰는 확장 번들에 TAG_COLOR 표가 남지 않게 한다
export const PERSONAL_COLOR = "bg-tag-personal-soft text-tag-personal border-transparent";

// 피그마 칩에는 테두리가 없다 (노드 152:255)
export const TAG_COLOR: Record<Tag, string> = {
  decision: "bg-tag-decision-soft text-tag-decision border-transparent",
  todo: "bg-tag-todo-soft text-tag-todo border border-tag-todo",
  research: "bg-tag-research-soft text-tag-research border-transparent",
  none: PERSONAL_COLOR,
};

// 승인함에서 체크된 카드 테두리. 새 피그마 4번은 표시와 상관없이 #57534e 1.5px (노드 152:281)
export const TAG_BORDER: Record<Tag, string> = {
  decision: "border-card-border-selected",
  todo: "border-card-border-selected",
  research: "border-card-border-selected",
  none: "border-card-border-selected",
};

// 발화 출처 (최근 수집 묶음·분석에서 제외된 발화). 카드 출처 이름(ai/syncup_ai/classify.py SITE_LABEL)과 같다
export const SITE_LABEL: Record<MessageSite, string> = {
  chatgpt: "ChatGPT",
  manual: "직접 입력",
  "chatgpt-export": "ChatGPT 내보내기",
  "file-upload": "파일 올리기",
  notion: "노션",
  "google-docs": "구글 문서",
  codex: "Codex",
  "claude-code": "Claude Code",
};

// 팀 보드 충돌 알림 3단계. 확신도 0.6 미만(또는 서버가 '확인 필요'로 판정)이면 판정과 상관없이 '확인 필요'
export type AlertLevel = "conflict" | "review" | "change";

export function alertLevel(x: Pick<Conflict, "judgement" | "confidence">): AlertLevel {
  if ((x.confidence !== undefined && x.confidence < LOW_CONFIDENCE) || (x.judgement as string) === "확인 필요") return "review";
  return x.judgement === "변경" ? "change" : "conflict";
}

// 충돌 알림 3단계 모양 (시안 "로즈 & 올리브 수채화"): 충돌 = 진갈색 채움 + 복숭아 글자, 확인 필요 = 진갈색 테두리, 변경 = 연분홍 채움.
// 보드 결정 카드(card)는 세 단계 모두 진갈색 1.5px 테두리 + 반투명 흰 바탕
export const ALERT_LEVEL: Record<AlertLevel, { label: string; badge: string; dot: string; card: string; banner: string; text: string; button: string }> = {
  conflict: {
    label: "충돌",
    badge: "bg-ink text-flare",
    dot: "bg-ink",
    card: "border border-ink bg-glass",
    banner: "border-ink bg-ink",
    text: "text-flare",
    button: "bg-flare text-ink hover:bg-flare/85",
  },
  review: {
    label: "확인 필요",
    badge: "border border-ink text-ink",
    dot: "border border-ink bg-transparent",
    card: "border border-ink bg-glass",
    banner: "border-ink bg-glass",
    text: "text-ink",
    button: "bg-ink text-white hover:bg-ink/85",
  },
  change: {
    label: "변경",
    badge: "bg-blush text-ink",
    dot: "bg-blush-deep",
    card: "border border-ink bg-glass",
    banner: "border-ink bg-blush",
    text: "text-ink",
    button: "bg-ink text-white hover:bg-ink/85",
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
  preAlert: "bg-alert-conflict-soft text-alert-conflict border-alert-conflict/20",
} as const;

export const LOW_CONFIDENCE = 0.6;

// 팀 보드·공유 후보에 올라갈 수 있는 카드 (관련 + 제안 아님)
export const isShareable = (c: Card): c is RelatedCard => c.relevance === "related" && c.tag !== "none";

// 상태 배지 목록 (순서 = 표시 순서). title 은 마우스를 올리면 보이는 설명
export function statusBadges(c: Card) {
  const badges: { label: string; color: string; title?: string }[] = [];
  if (c.confidence < LOW_CONFIDENCE) badges.push({ label: "확인 필요", color: BADGE_COLOR.lowConfidence });
  if (c.masked) badges.push({ label: "민감정보 가림", color: BADGE_COLOR.masked });
  // 같은 세부 주제의 팀 결정과 어긋나면 미리 알림 배지만 단다. 그 밖의 is_change 는 AI 가 본 '바꾸는 결정'이라 '변경 표현'
  // (팀 보드의 '변경'은 서버 충돌 판정이라 이름을 나눈다)
  if (c.relevance === "related" && c.preAlert) {
    badges.push({ label: PRE_ALERT_LABEL, color: BADGE_COLOR.preAlert, title: PRE_ALERT_HINT });
  } else if (c.relevance === "related" && c.is_change && c.tag === "decision") {
    badges.push({ label: "변경 표현", color: BADGE_COLOR.change, title: "AI가 기존 안을 바꾸는 결정으로 봤어요. 같은 세부 주제의 팀 결정과 어긋나면 '팀 결정과 어긋남'으로 따로 알려요." });
  }
  return badges;
}
