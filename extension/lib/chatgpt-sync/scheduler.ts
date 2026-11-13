// 동기화 켬·끔(syncSet), 싱크 맞추기(syncNow), 5분 알람 (docs/sync-contract.md 5장).
// 활발·조용 주기, touch, 쉼 두 배는 다음 단계다(약속 9장). 알람은 5분 고정이다
import type { ExtStatus, SyncNowParams, SyncNowResult } from '@shared/bridge';
import { errorText, rpc } from '../collector-rpc';
import type { BgResponse, SyncProject, TabSyncError } from '../messages';
import { sendBlockedReason, settingsItem } from '../settings';
import { findLeaderTab } from './leader-tab';
import { runSyncPass, syncLeftoverItem, syncTiming, waitForRunningPass } from './pass';
import { SYNC_ALARM, SYNC_DEFAULTS, SYNC_PERIOD_MINUTES, syncStateItem } from './state';

// 켬 실패 문구 (약속 5장 표). 팝업은 받은 문구를 그대로 보여 준다
export const SYNC_SET_ERRORS = {
  noTab: 'chatgpt.com 탭을 하나 열어 두세요',
  loggedOut: 'ChatGPT에 로그인하세요',
  oldCollector: '수집기를 새 버전으로 바꾸면 쓸 수 있어요',
  noProject: '프로젝트를 고르세요',
} as const;

// 켤 때 sync.session 이 받은 오류. 로그아웃 말고는 약속 표에 없어서 여기서 정한다
const SESSION_ERRORS: Record<TabSyncError, string> = {
  logged_out: SYNC_SET_ERRORS.loggedOut,
  rate_limited: 'ChatGPT 요청 제한에 걸렸어요. 잠시 뒤 다시 켜 주세요',
  forbidden: 'ChatGPT가 요청을 막았어요. 잠시 뒤 다시 켜 주세요',
  shape_changed: 'ChatGPT 응답 모양이 바뀌어 지금은 동기화를 켤 수 없어요',
  not_found: 'ChatGPT에 연결하지 못했어요. 잠시 뒤 다시 켜 주세요',
  network: 'ChatGPT에 연결하지 못했어요. 잠시 뒤 다시 켜 주세요',
};

export const startSyncAlarm = () => browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });

/** 서비스 워커가 시작할 때: 켜져 있는데 알람이 없으면 다시 만든다 (persistAcrossSessions 는 Chrome 150 부터) */
export async function ensureSyncAlarm() {
  const state = await syncStateItem.getValue();
  if (state.enabled && !(await browser.alarms.get(SYNC_ALARM))) await startSyncAlarm();
}

async function enableSync(project: SyncProject | undefined): Promise<BgResponse> {
  if (!project?.gizmoId) return { ok: false, error: SYNC_SET_ERRORS.noProject };
  const found = await findLeaderTab<null>({ type: 'sync.session' });
  if (!found) return { ok: false, error: SYNC_SET_ERRORS.noTab };
  if (!found.response.ok) return { ok: false, error: SESSION_ERRORS[found.response.error] };
  const account = found.response.account;
  try {
    const status = await rpc<ExtStatus>('collection.status');
    if (!status || !('accountSync' in status)) return { ok: false, error: SYNC_SET_ERRORS.oldCollector };
    await rpc('collection.configure', { accountSync: { enabled: true, account } });
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  // 켤 때마다 새로 시작한다(커서·pending·쉼). 통계만 이어 간다
  const { stats } = await syncStateItem.getValue();
  await syncLeftoverItem.setValue(false);
  await syncStateItem.setValue({
    ...SYNC_DEFAULTS,
    enabled: true,
    project,
    account,
    enabledAt: new Date(syncTiming.now()).toISOString(),
    mode: 'idle',
    stats,
  });
  await startSyncAlarm();
  await waitForRunningPass(); // 앞서 돌던 패스는 상태가 바뀐 것을 보고 결과를 쓰지 않고 멈춘다
  await runSyncPass();
  return { ok: true, result: await syncStateItem.getValue() };
}

// 수집기가 실패해도 확장 쪽은 끈다: 확장이 더는 ChatGPT 를 읽지 않게 하는 것이 먼저다
async function disableSync(): Promise<BgResponse> {
  const state = await syncStateItem.getValue();
  await syncStateItem.setValue({ ...state, enabled: false, mode: 'off', stopReason: null });
  await browser.alarms.clear(SYNC_ALARM);
  try {
    await rpc('collection.configure', { accountSync: { enabled: false } });
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  return { ok: true, result: await syncStateItem.getValue() };
}

/** BgRequest 'syncSet' (팝업에서만). 켬 결과는 { ok: true, result: SyncState } */
export const setSync = (enabled: boolean, project?: SyncProject) => (enabled ? enableSync(project) : disableSync());

/**
 * 싱크 맞추기: 패스를 한 번 돌리고(결과와 상관없이) 수집 중이면 collection.flush.
 * 확장의 syncNow 와 웹 브리지의 rpc(EXT_SYNC_NOW) 가 이 함수로 온다. flush 실패는 던진다
 */
export async function syncNow(_params?: SyncNowParams): Promise<SyncNowResult> {
  const { sync, newTurns } = await runSyncPass();
  const blockedReason = sendBlockedReason(await settingsItem.getValue());
  if (blockedReason) return { sync, newTurns, flushed: false, blockedReason };
  await rpc('collection.flush');
  return { sync, newTurns, flushed: true };
}
