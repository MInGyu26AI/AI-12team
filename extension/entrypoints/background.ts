// 백그라운드: 확장 화면들의 요청을 로컬 수집기로 넘기고, 30초마다 수집기 상태를 확장 저장소에 옮긴다.
// 프로젝트만 수집(계정 동기화)이 켜져 있으면 5분마다 동기화 패스를 돈다 (lib/chatgpt-sync).
import type { Browser } from 'wxt/browser';
import { EXT_SYNC_NOW, type SyncNowParams } from '@shared/bridge';
import { appendTurns } from '@/lib/append-turns';
import { runSyncPass } from '@/lib/chatgpt-sync/pass';
import {
  SYNCED_PROJECT_SCREEN_ERROR,
  isSyncedProjectPage,
  listSyncProjects,
  retryCollectorOff,
  setSync,
  startSyncScheduler,
  syncNow,
} from '@/lib/chatgpt-sync/scheduler';
import { SYNC_ALARM } from '@/lib/chatgpt-sync/state';
import { errorText, rpc } from '@/lib/collector-rpc';
import { clearError, clearErrorAndRefresh, recordFailure, refreshStatus, refreshStatusOrRecordFailure } from '@/lib/collector-status';
import { collectResultToast, type BgRequest, type BgResponse, type CollectResult, type TabToast, type TeamRecordRaw } from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import { sendBlockedReason, settingsItem } from '@/lib/settings';
import { CHAT_PAGE_MATCHES, siteForUrl } from '@/lib/sites';
import { isTrustedWebOrigin } from '@/lib/web-url';

const SELECTION_MENU_ID = 'syncup-send-selection';
const REFRESH_ALARM = 'refresh';
const SYNC_SET_POPUP_ONLY = '동기화 켬·끔은 확장 팝업에서만 바꿀 수 있어요';

// 동기화 동의는 팝업에서만 받는다: rpc 로 수집기 accountSync 를 바꾸는 요청(웹의 collection.configure)은 넘기지 않는다
const setsAccountSync = (method: string, params: unknown) =>
  method === 'collection.configure' && !!params && typeof params === 'object' && 'accountSync' in params;

// 확장 화면(팝업·채팅 화면)의 싱크 맞추기: '지금 분류하기'처럼 실패는 팝업 오류로 남기고, flush 뒤 상태를 다시 읽는다
async function syncNowFromExtension(params: SyncNowParams) {
  const result = await syncNow(params);
  if (result.flushed) await clearErrorAndRefresh();
  return { ok: true, result };
}

// 동기화로 고른 프로젝트의 화면 수집은 수집기로 보내지 않는다(약속 8-1 R3). 자동 수집은 조용히 넘기고, 수동·선택 보내기는 알린다
const syncedProjectResult = (trigger: Extract<BgRequest, { type: 'collect' }>['trigger']): CollectResult =>
  trigger === 'auto' ? { ok: true, newMessages: 0, intakeIssues: 0 } : { ok: false, error: SYNCED_PROJECT_SCREEN_ERROR };

// 팀 기록 불러오기(채팅 화면·팝업): 수집기 team.board·team.conflicts 응답 그대로. 실패 문구도 그대로 부른 화면에 돌려준다(웹 rpc 처럼)
async function teamRecord(): Promise<BgResponse> {
  try {
    const [board, conflicts] = await Promise.all([rpc('team.board'), rpc('team.conflicts')]);
    const result: TeamRecordRaw = { board, conflicts };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

// 콘텐츠 스크립트는 채팅 화면 출처만, 팝업과 설정한 개인 검토함 웹은 나머지 요청까지 보낼 수 있다.
// 단, 동기화 켬·끔(syncSet)·프로젝트 목록(syncProjects)은 팝업만, 팀 기록(teamRecord)은 채팅 화면·팝업,
// 싱크 맞추기(syncNow)는 채팅 화면·팝업·웹 모두 보낼 수 있다
async function handleRequest(message: BgRequest, sender: Browser.runtime.MessageSender) {
  const fromChat = !!sender.url && !!siteForUrl(sender.url);
  if (message.type === 'collect' && fromChat && (await isSyncedProjectPage(sender.url))) return syncedProjectResult(message.trigger);
  if (message.type === 'collect' && fromChat) return appendTurns(message.messages, message.trigger !== 'auto');
  if (message.type === 'syncNow' && fromChat) return syncNowFromExtension(message.params);
  if (message.type === 'teamRecord' && fromChat) return teamRecord();
  const fromPopup = !sender.tab && sender.id === browser.runtime.id;
  const fromWeb = !!sender.url && isTrustedWebOrigin(await settingsItem.getValue(), new URL(sender.url).origin);
  if (!fromPopup && !fromWeb) throw new Error('허용되지 않은 연결 화면');
  switch (message.type) {
    case 'rpc':
      // 웹 화면 요청의 실패는 웹 화면이 직접 알린다. 팝업의 연결 오류 표시는 확장 자신의 호출 결과만 따른다.
      // 웹의 싱크 맞추기(EXT_SYNC_NOW)는 수집기로 넘기지 않고 확장이 처리한다
      if (setsAccountSync(message.method, message.params)) return { ok: false, error: SYNC_SET_POPUP_ONLY };
      try {
        const sync = message.method === EXT_SYNC_NOW;
        return { ok: true, result: sync ? await syncNow(message.params as SyncNowParams) : await rpc(message.method, message.params) };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    case 'syncNow':
      return syncNowFromExtension(message.params);
    case 'syncSet':
      if (!fromPopup) throw new Error('허용되지 않은 연결 화면');
      return setSync(message.enabled, message.project);
    case 'syncProjects':
      if (!fromPopup) throw new Error('허용되지 않은 연결 화면');
      return listSyncProjects();
    case 'teamRecord':
      if (!fromPopup) throw new Error('허용되지 않은 연결 화면');
      return teamRecord();
    case 'flush':
      await rpc('collection.flush');
      await clearErrorAndRefresh();
      return { ok: true };
    case 'updateSettings':
      await rpc('collection.configure', message.patch);
      await clearError();
      // flush 와 달리 뒤따르는 새로 고침의 실패도 실패로 돌려준다: 처음 설정 화면은 팝업 오류를 보여 주지 않으므로 저장 화면이 알려야 한다
      await refreshStatus();
      return { ok: true };
    case 'refresh':
      return { ok: true, result: await refreshStatus() };
    default:
      throw new Error('지원하지 않는 요청');
  }
}

// 확장을 다시 불러온 뒤 새로고침하지 않은 탭에는 콘텐츠 스크립트가 없어 안내를 못 띄운다. 그 실패는 무시한다
const showToast = (tabId: number | undefined, toast: TabToast) => {
  if (tabId) browser.tabs.sendMessage(tabId, toast).catch(() => {});
};

// 모든 요청에 답한다. 실패는 팝업 오류로 남기고 { ok: false, error } 로 돌려준다
async function answer(message: BgRequest, sender: Browser.runtime.MessageSender) {
  try {
    return await handleRequest(message, sender);
  } catch (error) {
    return recordFailure(error, message?.type === 'refresh' ? 'refresh' : 'request');
  }
}

async function sendSelection(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab) {
  const url = tab?.url ?? '';
  const site = siteForUrl(url);
  const message = site && selectionMessage(site, info.selectionText ?? '', url, tab?.title ?? '');
  if (!message) return;
  const blocked = sendBlockedReason(await settingsItem.getValue());
  if (blocked) return showToast(tab?.id, { type: 'toast', text: blocked, tone: 'error' });
  if (await isSyncedProjectPage(url)) return showToast(tab?.id, collectResultToast(syncedProjectResult('selection')));
  try {
    showToast(tab?.id, collectResultToast(await appendTurns([message], true)));
  } catch (error) {
    showToast(tab?.id, collectResultToast(await recordFailure(error)));
  }
}

export default defineBackground(() => {
  void refreshStatusOrRecordFailure();
  browser.alarms.create(REFRESH_ALARM, { periodInMinutes: 0.5 });
  void startSyncScheduler();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REFRESH_ALARM) {
      void refreshStatusOrRecordFailure();
      void retryCollectorOff(); // 못 전한 동기화 끄기가 있으면 다시 보낸다
    }
    if (alarm.name === SYNC_ALARM) void runSyncPass();
  });
  browser.runtime.onStartup.addListener(() => void runSyncPass());
  // 리스너가 Promise 를 돌려주는 응답은 Chrome 148 부터라 그 전 버전에서는 보낸 쪽이 undefined 를 받는다.
  // 그래서 sendResponse 로 답하고, true 를 돌려 답할 때까지 채널을 열어 둔다
  browser.runtime.onMessage.addListener((message: BgRequest, sender, sendResponse) => {
    answer(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  });
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: SELECTION_MENU_ID,
      title: '싱크업에 선택한 내용 보내기',
      contexts: ['selection'],
      documentUrlPatterns: CHAT_PAGE_MATCHES,
    });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === SELECTION_MENU_ID) void sendSelection(info, tab);
  });
});
