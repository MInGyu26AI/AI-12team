// 계정 동기화("프로젝트만 수집") 상태. chrome.storage.local 에 둔다 (docs/sync-contract.md 5장).
// 패스·스케줄러(갈래 3)가 쓰고, 팝업(갈래 4)은 읽기만 한다. 켬·끔은 BgRequest 'syncSet' 으로 백그라운드에 맡긴다.
import { storage } from '#imports';
import type { SyncProject, TabSyncError } from '../messages';

// off = 꺼짐, idle = 켜져 있고 다음 알람 대기, running = 패스 중, rest = 요청 제한으로 쉼, stopped = 사용자가 고쳐야 함
export type SyncMode = 'off' | 'idle' | 'running' | 'rest' | 'stopped';

export type SyncStopReason =
  | 'collection_paused' // 수집 일시정지·종료
  | 'no_tab' // 응답하는 chatgpt.com 탭 없음
  | 'logged_out'
  | 'account_mismatch' // 탭 계정 ≠ 켤 때 묶은 계정
  | 'shape_changed' // ChatGPT 세션·사이드바·목록 응답 모양이 바뀜 (대화 하나의 모양 오류는 대화별 실패)
  | 'collector_off' // 수집기 accountSync 가 꺼졌거나 없거나 계정이 다름 (상태 폴더를 새로 만듦 등)
  | 'project_missing'; // 고른 프로젝트 목록이 404 (프로젝트를 지웠거나 접근 불가)

export interface SyncState {
  enabled: boolean;
  project: SyncProject | null; // 켜져 있으면 반드시 있음
  account: string | null; // 켤 때 묶은 계정 해시 (수집기 accountSync.account 와 같음)
  enabledAt: string | null; // ISO, 켠(동의한) 시각
  mode: SyncMode;
  stopReason: SyncStopReason | null; // mode='stopped' 일 때만
  cursor: string | null; // ISO. 마지막 완료 패스의 (pendingPassStartedAt − 10분). null = 창 시작부터
  pending: string[]; // 아직 상세를 받지 않은 대화 id (한 패스 상세 최대 20건, 다음 패스에서 이어 감)
  pendingPassStartedAt: string | null; // pending 을 만든 패스의 시작 시각. 커서를 올릴 때 이 값을 쓴다
  failures: Record<string, number>; // 대화 id → 연속 실패 수. SYNC_MAX_CONVERSATION_FAILURES 에 닿으면 그 대화를 건너뛴다
  collectorOffPending: boolean; // 끄기를 수집기에 아직 전하지 못함 → 다시 보낼 때까지 패스를 돌지 않는다
  lastPassStartedAt: string | null;
  lastPassFinishedAt: string | null;
  restUntil: string | null; // ISO. mode='rest' 일 때 다시 볼 시각
  restReason: Extract<TabSyncError, 'rate_limited' | 'forbidden'> | null;
  lastError: { code: TabSyncError | 'collector'; at: string } | null;
  stats: { passes: number; conversationsChecked: number; turnsSent: number; outsideWindow: number; skippedConversations: number };
}

export const SYNC_DEFAULTS: SyncState = {
  enabled: false,
  project: null,
  account: null,
  enabledAt: null,
  mode: 'off',
  stopReason: null,
  cursor: null,
  pending: [],
  pendingPassStartedAt: null,
  failures: {},
  collectorOffPending: false,
  lastPassStartedAt: null,
  lastPassFinishedAt: null,
  restUntil: null,
  restReason: null,
  lastError: null,
  stats: { passes: 0, conversationsChecked: 0, turnsSent: 0, outsideWindow: 0, skippedConversations: 0 },
};

export const syncStateItem = storage.defineItem<SyncState>('local:chatgptSync', { fallback: SYNC_DEFAULTS });

// 팀 고정값 (사용자 설정 없음, 회의록 3장 ①). 활발/조용 주기·touch·쉼 두 배는 다음 단계 (약속 9장)
export const SYNC_ALARM = 'chatgpt-sync';
export const SYNC_PERIOD_MINUTES = 5;
export const SYNC_MAX_DETAILS_PER_PASS = 20;
export const SYNC_DETAIL_GAP_MS: readonly [number, number] = [1000, 2000]; // 상세 요청 사이 무작위 간격
export const SYNC_CURSOR_SLACK_MINUTES = 10;
export const SYNC_TAB_TIMEOUT_MS = 20_000;
export const SYNC_APPEND_CHUNK = 200; // turns.append 한 번에 보내는 메시지 수 (수집기 MAX_APPEND)
// turns.append 한 번의 추정 크기 상한. JSON.stringify 길이에서 ASCII 밖 글자를 6바이트로 센다
// (native host 가 ensure_ascii 로 다시 직렬화하고, 수집기 HTTP 본문 상한이 4 MiB 다)
export const SYNC_APPEND_MAX_BYTES = 2.5 * 1024 * 1024;
export const SYNC_MAX_CONVERSATION_FAILURES = 3;
export const SYNC_STALE_IN_PROGRESS_MINUTES = 10; // 이보다 오래 미완료인 마지막 턴은 커서를 붙잡지 않는다
export const SYNC_REST_DEFAULT_MINUTES = 30; // 429 에 Retry-After 가 없을 때
export const SYNC_FORBIDDEN_REST_MINUTES = 120;
