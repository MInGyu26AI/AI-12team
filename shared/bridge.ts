// 웹 ↔ 확장 프로그램(web-bridge 콘텐츠 스크립트) window.postMessage 형식
import type { RelatedCard } from "./types";

export const BRIDGE_FROM_WEB = "syncup-web";
export const BRIDGE_FROM_EXT = "syncup-ext";

// 확장의 대화 수집 한 묶음 (10턴마다 분류된 것)
export interface BatchRecord {
  id: string;
  at: string; // ISO
  site: string; // "ChatGPT"
  turns: number; // 대화 횟수 (질문 + 답변 = 1턴)
  cardIds: string[]; // 이 묶음에서 나온 검토 대기 카드 (공유 후보만)
  personal?: number; // 버린 개인 내용 수 (내용은 저장하지 않음)
  trigger: "auto" | "flush" | "manual" | "selection";
}

export interface ExtStatus {
  teamId?: string;
  teams?: { id: string; name: string }[];
  projectTopic?: string;
  failedJobs?: { id: string; detail: string }[];
  legacyCandidates?: number;
  version: string;
  configured: boolean;
  autoCollect: boolean; // false = 수집 일시정지
  turnsPerBatch: number;
  bufferedTurns: number; // 아직 분류에 안 보낸 대화 수
  endsAt: string | null; // 수집 종료 시각 (ISO)
  lastCollectedAt: string | null;
  lastClassifier: "native" | "mock" | null;
  teamName: string;
  userName: string;
  recent: BatchRecord[]; // 최근 수집 (새 것부터)
  counts?: Partial<Record<"reviewPending" | "deliveryPending" | "deliveryBlocked" | "classificationPending" | "classificationFailed" | "intakeIssues" | "privacyHeld" | "privacyExcluded", number>>;
  privacy?: { policy: string; model: string | null; available: boolean | null; reason: string | null }; // 로컬 개인정보 검사 상태
}

// 로컬 개인정보 검사 (privacy.list). 원문 미리보기는 형식 가림만 적용된 로컬 전용 값이다.
export type PrivacyDecision = "allow" | "exclude" | "hold";

export interface PrivacyMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  decision: PrivacyDecision | null;
  reason: string | null;
}

export interface PrivacyHold {
  id: string; // 작업(묶음) ID
  reason: string;
  decidedAt: number; // Unix 초
  messages: PrivacyMessage[];
}

export interface PrivacyExcluded {
  jobId: string;
  messageId: string;
  reason: string | null;
  decidedAt: number;
  role: "user" | "assistant" | null;
  site: string | null;
  collectedAt: string | null;
  text: string;
}

export interface PrivacyList {
  teamId: string;
  items: PrivacyHold[]; // 확인 필요 묶음
  excluded: PrivacyExcluded[]; // 분석에서 제외된 발화 (최근 순, 최대 200)
  excludedCount: number;
}

// 웹에서 바꿀 수 있는 확장 설정 (팀 만들기 → 확장 설정 채우기, 대화 수집 화면의 수집 기준)
export interface ExtSettingsPatch {
  teamId?: string;
  teamName?: string;
  projectTopic?: string;
  userName?: string;
  autoCollect?: boolean;
  turnsPerBatch?: number;
  endsAt?: string | null;
}

// 웹 → 확장
export type WebToExt =
  | { source: typeof BRIDGE_FROM_WEB; type: "hello" } // "확장 있으면 검토 대기 카드·상태 보내 줘"
  | { source: typeof BRIDGE_FROM_WEB; type: "remove"; ids: string[]; reason: "approved" | "dismissed" }
  | { source: typeof BRIDGE_FROM_WEB; type: "updateSettings"; patch: ExtSettingsPatch }
  | { source: typeof BRIDGE_FROM_WEB; type: "flush" }; // 쌓인 대화 지금 분류

// 확장 → 웹
export type ExtToWeb = {
  source: typeof BRIDGE_FROM_EXT;
  type: "pending";
  cards: RelatedCard[]; // 개인(personal)은 이미 버렸고, 민감정보는 가린 상태
  userName: string;
  status?: ExtStatus; // v0.2 부터
};

export const isExtToWeb = (d: unknown): d is ExtToWeb =>
  typeof d === "object" && d !== null && (d as ExtToWeb).source === BRIDGE_FROM_EXT && (d as ExtToWeb).type === "pending";

export const isWebToExt = (d: unknown): d is WebToExt =>
  typeof d === "object" && d !== null && (d as WebToExt).source === BRIDGE_FROM_WEB;
