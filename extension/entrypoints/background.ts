// 백그라운드: 확장 화면들의 요청을 로컬 수집기로 넘기고, 30초마다 수집기 상태를 확장 저장소에 옮긴다.
import type { Browser } from 'wxt/browser';
import { appendTurns } from '@/lib/append-turns';
import { errorText, rpc } from '@/lib/collector-rpc';
import { clearError, clearErrorAndRefresh, recordFailure, refreshStatus, refreshStatusOrRecordFailure } from '@/lib/collector-status';
import { collectResultToast, type BgRequest, type TabToast } from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import { settingsItem } from '@/lib/settings';
import { CHAT_PAGE_MATCHES, siteForUrl } from '@/lib/sites';
import { isTrustedWebOrigin } from '@/lib/web-url';

const SELECTION_MENU_ID = 'syncup-send-selection';

// 콘텐츠 스크립트는 채팅 화면 출처만, 팝업과 설정한 개인 검토함 웹은 나머지 요청까지 보낼 수 있다
async function handleRequest(message: BgRequest, sender: Browser.runtime.MessageSender) {
  const fromChat = !!sender.url && !!siteForUrl(sender.url);
  if (message.type === 'collect' && fromChat) return appendTurns(message.messages, message.trigger !== 'auto');
  const fromPopup = !sender.tab && sender.id === browser.runtime.id;
  const fromWeb = !!sender.url && isTrustedWebOrigin(await settingsItem.getValue(), new URL(sender.url).origin);
  if (!fromPopup && !fromWeb) throw new Error('허용되지 않은 연결 화면');
  switch (message.type) {
    case 'rpc':
      // 웹 화면 요청의 실패는 웹 화면이 직접 알린다. 팝업의 연결 오류 표시는 확장 자신의 호출 결과만 따른다
      try {
        return { ok: true, result: await rpc(message.method, message.params) };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
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
  try {
    showToast(tab?.id, collectResultToast(await appendTurns([message], true)));
  } catch (error) {
    showToast(tab?.id, collectResultToast(await recordFailure(error)));
  }
}

export default defineBackground(() => {
  void refreshStatusOrRecordFailure();
  browser.alarms.create('refresh', { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener(() => void refreshStatusOrRecordFailure());
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
