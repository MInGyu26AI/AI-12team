// 계정 동기화("프로젝트만 수집") 상태. chrome.storage.local 에 둔다 (docs/sync-contract.md 5장).
// 패스·스케줄러(갈래 5)가 쓰고, 팝업(갈래 6)은 읽기만 한다. 켬·끔은 BgRequest 'syncSet' 으로 백그라운드에 맡긴다.
import { storage } from '#imports';
import type { SyncProject, TabSyncError } from '../messages';

export type SyncMode = 'off' | 'active' | 'quiet' | 'rest' | 'stopped';

// 멈춤 이유. 사용자가 고쳐야 다시 돈다 (스케줄러는 알람마다 조건을 다시 본다)
export type SyncStopReason =
  | 'collection_paused' // 수집 일시정지·종료
  | 'no_tab' // 응답하는 chatgpt.com 탭 없음
  | 'logged_out'
  | 'account_mismatch' // 탭 계정 ≠ 켤 때 묶은 계정
  | 'shape_changed' // ChatGPT 응답 모양이 바뀜
  | 'old_collector'; // 수집기 status 에 syncWindows 가 없음

export interface SyncState {
  enabled: boolean;
  project: SyncProject | null; // 켜져 있으면 반드시 있음
  account: string | null; // 켤 때 묶은 계정 해시 (수집기 accountSync.account 와 같음)
  enabledAt: string | null; // ISO, 켠(동의한) 시각
  mode: SyncMode;
  stopReason: SyncStopReason | null; // mode='stopped' 일 때만
  cursor: string | null; // ISO. 이 시각보다 updateTime 이 오래된 대화는 보지 않는다. null = 동기화 창 시작부터
  pending: string[]; // 이번 패스에서 남은 대화 id (한 패스 상세 최대 20건, 다음 알람에서 이어 감)
  lastPassStartedAt: string | null;
  lastPassFinishedAt: string | null; // 완료 패스(남은 대상 없음)
  lastTouchAt: string | null; // 화면 경로 collect 요청 시각 (활발 주기 판단)
  lastNewTurnsAt: string | null; // 패스가 새 턴을 찾은 시각 (활발 주기 판단)
  restUntil: string | null; // ISO. mode='rest' 일 때 다시 볼 시각
  restReason: Extract<TabSyncError, 'rate_limited' | 'forbidden'> | null;
  backoffMinutes: number; // 쉼이 거듭되면 두 배 (30 → 최대 120). 성공 패스 뒤 0
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
  lastPassStartedAt: null,
  lastPassFinishedAt: null,
  lastTouchAt: null,
  lastNewTurnsAt: null,
  restUntil: null,
  restReason: null,
  backoffMinutes: 0,
  lastError: null,
  stats: { passes: 0, conversationsChecked: 0, turnsSent: 0, outsideWindow: 0 },
};

export const syncStateItem = storage.defineItem<SyncState>('local:chatgptSync', { fallback: SYNC_DEFAULTS });

// 팀 고정값 (사용자 설정 없음, 회의록 3장 ①)
export const SYNC_ALARM = 'chatgpt-sync';
export const SYNC_ACTIVE_MINUTES = 2; // P5 통과 시 1
export const SYNC_QUIET_MINUTES = 5;
export const SYNC_ACTIVE_WINDOW_MINUTES = 10; // 최근 이 안에 touch·새 턴이 있으면 활발
export const SYNC_MAX_DETAILS_PER_PASS = 20;
export const SYNC_CURSOR_SLACK_MINUTES = 10;
export const SYNC_TOUCH_DELAY_MS = 5000; // collect 요청 뒤 패스를 돌리기까지
export const SYNC_TAB_TIMEOUT_MS = 20_000;
export const SYNC_REST_DEFAULT_MINUTES = 30;
export const SYNC_REST_MAX_MINUTES = 120;
export const SYNC_FORBIDDEN_REST_MINUTES = 120;
