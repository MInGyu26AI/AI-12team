import { NATIVE_HOST } from '@shared/collector';
import type { ExtStatus } from '@shared/bridge';
import type { RelatedCard } from '@shared/types';
import { settingsItem, pendingItem, collectStateItem, webUrlOf } from '@/lib/settings';
import { LOCAL_WEB_URL } from '@/lib/config';
import { selectionMessage } from '@/lib/selection';

async function rpc(method: string, params: unknown = {}) {
  const response = await browser.runtime.sendNativeMessage(NATIVE_HOST, { version: 1, method, params });
  if (!response?.ok) throw new Error(response?.error ?? '로컬 수집기 연결 실패');
  return response.result;
}
async function refresh() {
  const result = await rpc('candidates.list') as { cards: RelatedCard[]; status: ExtStatus };
  const previous = await settingsItem.getValue();
  await settingsItem.setValue({ ...previous, ...result.status });
  await pendingItem.setValue(result.cards);
  await browser.action.setBadgeText({ text: result.cards.length ? String(result.cards.length) : '' });
  return result;
}
async function collect(messages: unknown[], flush: boolean) {
  const result = await rpc('turns.append', { messages, flush });
  await refresh();
  return { ok: true, newMessages: result.newMessages, newCards: 0 };
}
const fail = async (error: unknown) => {
  const message = error instanceof Error ? error.message : '로컬 연결 오류';
  await collectStateItem.setValue({ ...await collectStateItem.getValue(), lastError: message });
  return { ok: false, error: message };
};

export default defineBackground(() => {
  void refresh().catch(fail);
  browser.alarms.create('refresh', { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener(() => { void refresh().catch(fail); });
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
        const result = await rpc(message.method, message.params);
        return { ok: true, result };
      }
      if (message.type === 'flush') { await rpc('collection.flush'); return { ok: true, newCards: 0 }; }
      if (message.type === 'updateSettings') { await rpc('collection.configure', message.patch); await refresh(); return { ok: true }; }
      if (message.type === 'refresh') return { ok: true, result: await refresh() };
      throw new Error('지원하지 않는 요청');
    } catch (error) { return fail(error); }
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
