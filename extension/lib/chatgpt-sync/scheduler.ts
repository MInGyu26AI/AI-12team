// 동기화 켬·끔(syncSet), 프로젝트 목록(syncProjects), 싱크 맞추기(syncNow), 5분 알람 (docs/sync-contract.md 5장).
// 활발·조용 주기, touch, 쉼 두 배는 다음 단계다(약속 9장). 알람은 5분 고정이다
import type { ExtStatus, SyncNowParams, SyncNowResult } from '@shared/bridge';
import { errorText, rpc } from '../collector-rpc';
import type { BgResponse, SyncProject, TabSyncError, TabSyncRequest, TabSyncResult } from '../messages';
import { sendBlockedReason, settingsFromStatus, settingsItem } from '../settings';
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

// 끄기가 수집기에 닿지 못했을 때 (약속 5장 끔 2)
export const SYNC_OFF_PENDING_ERROR = '수집기에 끄기를 전하지 못했어요. 수집기를 켜면 다시 보낼게요';

// 켤 때(sync.session)·프로젝트 목록(sync.projects)이 받은 탭 오류. 로그아웃 말고는 약속 표에 없어서 여기서 정한다
const TAB_ERRORS: Record<TabSyncError, string> = {
  logged_out: SYNC_SET_ERRORS.loggedOut,
  rate_limited: 'ChatGPT 요청 제한에 걸렸어요. 잠시 뒤 다시 시도해 주세요',
  forbidden: 'ChatGPT가 요청을 막았어요. 잠시 뒤 다시 시도해 주세요',
  shape_changed: 'ChatGPT 응답 모양이 바뀌어 지금은 동기화를 쓸 수 없어요',
  not_found: 'ChatGPT에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요',
  network: 'ChatGPT에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요',
};

/** 대표 탭에 한 번 묻는다. 답하는 탭이 없거나 탭 오류면 팝업에 보일 문구 */
async function askTab<T>(request: TabSyncRequest): Promise<{ ok: true; response: Extract<TabSyncResult<T>, { ok: true }> } | { ok: false; error: string }> {
  const found = await findLeaderTab<T>(request);
  if (!found) return { ok: false, error: SYNC_SET_ERRORS.noTab };
  if (!found.response.ok) return { ok: false, error: TAB_ERRORS[found.response.error] };
  return { ok: true, response: found.response };
}

export const startSyncAlarm = () => browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });

// 수집기 accountSync 를 바꾸는 일(켬·끔·끄기 다시 보내기)은 하나씩 한다. 끄기 다시 보내기가 켬 사이에 끼면 켠 것을 도로 끈다
let accountSyncQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const result = accountSyncQueue.then(task, task);
  accountSyncQueue = result.catch(() => {});
  return result;
}

const configureOff = () => rpc('collection.configure', { accountSync: { enabled: false } });

async function setCollectorOffPending(pending: boolean) {
  const latest = await syncStateItem.getValue();
  if (latest.collectorOffPending !== pending) await syncStateItem.setValue({ ...latest, collectorOffPending: pending });
}

/** 끄기를 수집기에 아직 전하지 못했으면 다시 보낸다 (서비스 워커 시작·30초 refresh 알람마다). 실패는 다음에 다시 */
export const retryCollectorOff = () =>
  oneAtATime(async () => {
    if (!(await syncStateItem.getValue()).collectorOffPending) return;
    try {
      await configureOff();
    } catch {
      return;
    }
    await setCollectorOffPending(false);
  });

/** 서비스 워커가 시작할 때: 켜져 있는데 알람이 없으면 다시 만들고(persistAcrossSessions 는 Chrome 150 부터), 못 전한 끄기를 다시 보낸다 */
export async function startSyncScheduler() {
  const state = await syncStateItem.getValue();
  if (state.enabled && !(await browser.alarms.get(SYNC_ALARM))) await startSyncAlarm();
  await retryCollectorOff();
}

/** 수집기에 켬을 묶고 확장 상태를 새로 시작한다. 실패하면 팝업 문구 */
const bindCollector = (project: SyncProject, account: string) =>
  oneAtATime(async (): Promise<string | null> => {
    try {
      const status = await rpc<ExtStatus>('collection.status');
      if (!status || !('accountSync' in status)) return SYNC_SET_ERRORS.oldCollector;
      // 수집기가 이미 켜져 있으면(끄기가 닿지 않았거나 확장을 다시 깖, 켜진 채 프로젝트·계정을 바꿈) 먼저 끈다.
      // 그래야 수집기의 켬 시각(since)이 지금으로 새로 찍혀 꺼 둔 동안의 대화가 들어오지 않는다
      if (status.accountSync?.enabled || (await syncStateItem.getValue()).collectorOffPending) await configureOff();
      await rpc('collection.configure', { accountSync: { enabled: true, account } });
    } catch (error) {
      return errorText(error);
    }
    // 켤 때마다 새로 시작한다(커서·pending·failures·쉼·못 전한 끄기). 통계만 이어 간다
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
    return null;
  });

async function enableSync(project: SyncProject | undefined): Promise<BgResponse> {
  if (!project?.gizmoId) return { ok: false, error: SYNC_SET_ERRORS.noProject };
  const session = await askTab<null>({ type: 'sync.session' });
  if (!session.ok) return session;
  const failed = await bindCollector(project, session.response.account);
  if (failed) return { ok: false, error: failed };
  await startSyncAlarm();
  await waitForRunningPass(); // 앞서 돌던 패스는 상태가 바뀐 것을 보고 결과를 쓰지 않고 멈춘다
  await runSyncPass();
  return { ok: true, result: await syncStateItem.getValue() };
}

// 확장 쪽을 먼저 끈다: 확장이 더는 ChatGPT 를 읽지 않게 하는 것이 먼저다. 수집기가 실패하면 나중에 다시 보낸다
const disableSync = () =>
  oneAtATime(async (): Promise<BgResponse> => {
    const state = await syncStateItem.getValue();
    await syncStateItem.setValue({ ...state, enabled: false, mode: 'off', stopReason: null });
    await browser.alarms.clear(SYNC_ALARM);
    try {
      await configureOff();
    } catch {
      await setCollectorOffPending(true);
      return { ok: false, error: SYNC_OFF_PENDING_ERROR };
    }
    await setCollectorOffPending(false);
    return { ok: true, result: await syncStateItem.getValue() };
  });

/** BgRequest 'syncSet' (팝업에서만). 켬 결과는 { ok: true, result: SyncState } */
export const setSync = (enabled: boolean, project?: SyncProject) => (enabled ? enableSync(project) : disableSync());

/** BgRequest 'syncProjects' (팝업에서만): 켜기 전에 고를 프로젝트 목록. 동기화가 꺼져 있어도 된다 */
export async function listSyncProjects(): Promise<BgResponse> {
  const projects = await askTab<SyncProject[]>({ type: 'sync.projects' });
  return projects.ok ? { ok: true, result: projects.response.data } : projects;
}

/**
 * 싱크 맞추기: 패스를 한 번 돌리고, 결과와 상관없이 수집 중이면 collection.flush.
 * 수집 중인지는 캐시된 설정이 아니라 이번 패스가 읽은(돌지 않았으면 새로 읽은) collection.status 로 본다.
 * 확장의 syncNow 와 웹 브리지의 rpc(EXT_SYNC_NOW) 가 이 함수로 온다. 수집기 실패도 던지지 않고 패스 결과와 함께 돌려준다
 */
export async function syncNow(_params?: SyncNowParams): Promise<SyncNowResult> {
  const { sync, newTurns, status } = await runSyncPass();
  try {
    const fresh = status ?? (await rpc<ExtStatus>('collection.status'));
    const blockedReason = sendBlockedReason(settingsFromStatus(await settingsItem.getValue(), fresh), syncTiming.now());
    if (blockedReason) return { sync, newTurns, flushed: false, blockedReason };
    await rpc('collection.flush');
    return { sync, newTurns, flushed: true };
  } catch (error) {
    return { sync, newTurns, flushed: false, blockedReason: errorText(error) };
  }
}
