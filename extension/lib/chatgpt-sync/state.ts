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
  | 'shape_changed'; // ChatGPT 응답 모양이 바뀜

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
  lastPassStartedAt: string | null;
  lastPassFinishedAt: string | null;
  restUntil: string | null; // ISO. mode='rest' 일 때 다시 볼 시각
  restReason: Extract<TabSyncError, 'rate_limited' | 'forbidden'> | null;
  lastError: { code: TabSyncError | 'collector'; at: string } | null;
  stats: { passes: number; conversationsChecked: number; turnsSent: number; outsideWindow: number };
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
  lastPassStartedAt: null,
  lastPassFinishedAt: null,
  restUntil: null,
  restReason: null,
  lastError: null,
  stats: { passes: 0, conversationsChecked: 0, turnsSent: 0, outsideWindow: 0 },
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
export const SYNC_REST_DEFAULT_MINUTES = 30; // 429 에 Retry-After 가 없을 때
export const SYNC_FORBIDDEN_REST_MINUTES = 120;
