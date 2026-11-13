// 웹 ↔ 확장 window.postMessage 식별자와 로컬 수집기 RPC 결과 타입.
// 메시지는 type:'rpc' / 'rpc-ack'(받자마자) / 'rpc-result' 다 (web/src/lib/rpc.ts ↔ extension/entrypoints/web-bridge.content.ts)
import type { CollectedMessage } from "./collector";
import type { Subtopic } from "./types";

export const BRIDGE_FROM_WEB = "syncup-web";
export const BRIDGE_FROM_EXT = "syncup-ext";

// 수집기에 쌓인 발화의 출처: turns.append 사이트와 코딩 도구.
// claude-code 는 스캐너가 붙이고, codex 는 출처가 없는 스캐너 발화에 turn_intake 가 붙이는 기본값이다
export type MessageSite = CollectedMessage["site"] | "codex" | "claude-code";

// 분류를 마친 수집 묶음 한 개 (collection.status 의 recent)
export interface BatchRecord {
  id: string;
  at: string; // ISO
  site: MessageSite; // 묶음 첫 발화의 출처
  turns: number; // 대화 횟수 (질문 + 답변 = 1턴)
  cardIds: string[]; // 이 묶음에서 나온 공유 후보 카드 (이미 승인한 카드 포함)
  // 묶음을 대기열에 넣은 요청: flush = 남은 대화까지 보내기(collection.flush, flush 인 turns.append), manual = intake.retry
  trigger: "auto" | "flush" | "manual";
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
  bufferedTurns: number; // 아직 분류에 안 보낸 대화 수 (모든 대화 합계, '지금 분류하기'로 보낼 것이 있는지)
  nextBatchTurns?: number; // 다음 자동 분류에 가장 가까운 대화의 답을 받은 턴 수 (turnsPerBatch 가 되면 분류). 옛 수집기는 없음
  endsAt: string; // 수집 종료 시각 (ISO)
  lastCollectedAt: string | null;
  lastClassifier: "native" | null;
  teamName: string;
  userName: string;
  recent: BatchRecord[]; // 최근 수집 (새 것부터)
  counts?: Partial<Record<"reviewPending" | "deliveryPending" | "deliveryBlocked" | "classificationPending" | "classificationFailed" | "intakeIssues" | "privacyHeld" | "privacyExcluded", number>>;
  privacy?: { policy: string; model: string | null; available: boolean | null; reason: string | null }; // 로컬 개인정보 검사 상태
  // 계정 동기화 (docs/sync-contract.md 3장). 옛 수집기는 없음 → 확장은 동기화를 켜지 못하게 한다
  syncWindows?: SyncWindow[]; // 동기화 창: 수집 기간 ∩ 동기화 켠 구간 − 일시정지 구간 (시작 순)
  accountSync?: AccountSyncState | null; // null = 한 번도 켠 적 없음
}

// 동기화 창 한 구간 [start, end). end=null 은 아직 열려 있음(지금 수집 중이고 동기화 켜짐)
export interface SyncWindow {
  start: string; // ISO
  end: string | null; // ISO
}

export interface AccountSyncState {
  enabled: boolean;
  account: string; // 묶인 ChatGPT 계정 해시 (sha256 hex 64자). 꺼도 마지막 값을 둔다
  since: string | null; // 지금 켜진 구간의 시작(동의 시각, ISO). 꺼져 있으면 null
}

// 웹 → 확장 '싱크 맞추기' (rpc 메시지의 method 이름). 수집기로 넘기지 않고 background 가 처리한다:
// 프로젝트 동기화 패스를 바로 한 번 돌리고(켜져 있을 때) collection.flush 를 부른다
export const EXT_SYNC_NOW = "ext.syncNow";

export interface SyncNowParams {
  reason: "button" | "review-open"; // 버튼 = 사용자가 누름, review-open = 개인 검토함 진입 시 자동
}

export interface SyncNowResult {
  sync: "ran" | "off" | "resting" | "no-tab" | "busy" | "failed"; // 패스 결과. off = 동기화 꺼짐(화면 수집만)
  newTurns: number; // 이번 패스가 수집기에 새로 넣은 턴 수 (패스를 안 돌렸으면 0)
  flushed: boolean; // collection.flush 를 불렀는지 (수집 중이 아니면 false)
  blockedReason?: string; // flush 를 못 부른 이유 (sendBlockedReason 과 같은 문구)
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
  site: MessageSite | null;
  collectedAt: string | null;
  text: string;
}

export interface PrivacyList {
  teamId: string;
  items: PrivacyHold[]; // 확인 필요 묶음
  excluded: PrivacyExcluded[]; // 분석에서 제외된 발화 (최근 순, 최대 200)
  excludedCount: number;
}

// collection.configure 가 받는 수집 설정 (collection_settings.CONFIGURABLE)
export interface ExtSettingsPatch {
  teamId?: string;
  projectTopic?: string;
  enabledSubtopics?: Subtopic[];
  autoCollect?: boolean;
  turnsPerBatch?: number;
  endsAt?: string;
  // 계정 동기화 켬·끔 (C6). 켤 때 account 필수. 다른 계정으로 켜려면 먼저 꺼야 한다(수집기가 거절)
  accountSync?: { enabled: boolean; account?: string };
}
