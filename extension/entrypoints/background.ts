import { NATIVE_HOST } from '@shared/collector';
import type { ExtStatus } from '@shared/bridge';
import type { RelatedCard } from '@shared/types';
import { isShareable } from '@shared/labels';
import { settingsItem, pendingItem, collectStateItem, webUrlOf } from '@/lib/settings';
import { LOCAL_WEB_URL } from '@/lib/config';
import { selectionMessage } from '@/lib/selection';

// 로컬 수집기에 닿지 못한 실패(연결)와 수집기가 요청을 거절한 실패를 구분한다. 상태 새로 고침이 성공하면 연결 실패와
// 새로 고침 자신의 실패를 지우고, 수집·지금 분류·설정 저장이 거절된 오류는 그 요청이 다시 성공할 때까지 팝업에 남긴다.
class CollectorUnreachable extends Error {}
const errorText = (error: unknown) => (error instanceof Error ? error.message : '로컬 연결 오류');
async function rpc(method: string, params: unknown = {}) {
  let response;
  try {
    response = await browser.runtime.sendNativeMessage(NATIVE_HOST, { version: 1, method, params });
  } catch (error) {
    throw new CollectorUnreachable(errorText(error));
  }
  if (!response) throw new CollectorUnreachable('로컬 수집기 연결 실패');
  // native_host.py 는 로컬 수집기에 연결하지 못하면 code: 'unreachable' 로 답한다
  if (!response.ok && response.code === 'unreachable') throw new CollectorUnreachable(response.error);
  if (!response.ok) throw new Error(response.error ?? '로컬 수집기 요청 실패');
  return response.result;
}
async function refresh() {
  const result = await rpc('candidates.list') as { cards: RelatedCard[]; status: ExtStatus };
  const previous = await settingsItem.getValue();
  await settingsItem.setValue({ ...previous, ...result.status });
  await pendingItem.setValue(result.cards);
  const state = await collectStateItem.getValue();
  if (state.lastError && (state.op === 'refresh' || state.unreachable !== false)) await collectStateItem.setValue({ lastError: null });
  // 수집기는 공유 후보만 보낸다. 이 필터는 프로세스 경계의 방어용이고, 팝업 숫자와 같은 기준이다
  const shareable = result.cards.filter(isShareable).length;
  await browser.action.setBadgeText({ text: shareable ? String(shareable) : '' });
  return result;
}
const fail = async (error: unknown, op: 'refresh' | 'request' = 'request') => {
  const message = errorText(error);
  await collectStateItem.setValue({ lastError: message, unreachable: error instanceof CollectorUnreachable, op });
  return { ok: false, error: message };
};
const failRefresh = (error: unknown) => fail(error, 'refresh');
// 요청 자체가 성공하면 이전 오류를 지우고, 뒤따르는 새로 고침의 실패는 기록만 한다 (요청 결과는 성공 그대로)
const succeeded = async () => {
  await collectStateItem.setValue({ lastError: null });
  await refresh().catch(failRefresh);
};
async function collect(messages: unknown[], flush: boolean) {
  const result = await rpc('turns.append', { messages, flush });
  await succeeded();
  return { ok: true, newMessages: result.newMessages, newCards: 0 };
}

export default defineBackground(() => {
  void refresh().catch(failRefresh);
  browser.alarms.create('refresh', { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener(() => { void refresh().catch(failRefresh); });
  browser.runtime.onMessage.addListener(async (message, sender) => {
    try {
      const settings = await settingsItem.getValue();
      const origin = sender.url ? new URL(sender.url).origin : '';
      const own = !sender.tab && sender.id === browser.runtime.id;
      const web = [webUrlOf(settings), LOCAL_WEB_URL, 'http://127.0.0.1:3000'].includes(origin);
      const chat = ['https://chatgpt.com', 'https://chat.openai.com'].includes(origin);
      if (message.type === 'collect' && chat) return await collect(message.messages, message.trigger !== 'auto');
      if (!own && !web) throw new Error('허용되지 않은 연결 화면');
      if (message.type === 'rpc') {
        // 웹 화면 요청의 실패는 웹 화면이 직접 알린다. 팝업의 연결 오류 표시는 확장 자신의 호출 결과만 따른다
        try {
          return { ok: true, result: await rpc(message.method, message.params) };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      }
      if (message.type === 'flush') {
        await rpc('collection.flush');
        await succeeded();
        return { ok: true, newCards: 0 };
      }
      if (message.type === 'updateSettings') {
        await rpc('collection.configure', message.patch);
        await collectStateItem.setValue({ lastError: null });
        // flush 와 달리 뒤따르는 새로 고침의 실패도 실패로 돌려준다: 처음 설정 화면은 팝업 오류를 보여 주지 않으므로 저장 화면이 알려야 한다
        await refresh();
        return { ok: true };
      }
      if (message.type === 'refresh') return { ok: true, result: await refresh() };
      throw new Error('지원하지 않는 요청');
    } catch (error) { return fail(error, message?.type === 'refresh' ? 'refresh' : 'request'); }
  });
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: 'syncup-send-selection', title: '싱크업에 선택한 내용 보내기', contexts: ['selection'], documentUrlPatterns: ['https://chatgpt.com/*','https://chat.openai.com/*'] });
  });
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'syncup-send-selection') return;
    const message = selectionMessage(info.selectionText ?? '', tab?.url ?? '', tab?.title ?? '');
    if (!message) return;
    try {
      await collect([message], true);
      if (tab?.id) await browser.tabs.sendMessage(tab.id, { type: 'toast', text: '분류 대기함에 저장했어요', tone: 'ok' });
    } catch (error) {
      const result = await fail(error);
      if (tab?.id) await browser.tabs.sendMessage(tab.id, { type: 'toast', text: result.error, tone: 'error' });
    }
  });
});
