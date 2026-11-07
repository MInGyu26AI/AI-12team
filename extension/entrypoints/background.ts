// 서비스 워커: 수집한 메시지 → 분류 → 개인 버림·민감정보 가림 → 검토 대기 저장 → 아이콘 배지
import type { RelatedCard } from '@shared/types';
import { classifyWithFallback } from '@/lib/classifier';
import type { BgRequest, CollectResult, TabToast } from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import {
  MAX_REMEMBERED_IDS,
  collectStateItem,
  isConfigured,
  pendingItem,
  settingsItem,
} from '@/lib/settings';

// storage 읽고-쓰기가 겹치지 않도록 한 줄로 세움
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
};

async function collect(req: Extract<BgRequest, { type: 'collect' }>): Promise<CollectResult> {
  const settings = await settingsItem.getValue();
  if (!isConfigured(settings)) return { ok: false, error: '설정 안 됨: 팝업에서 팀 정보를 먼저 입력해 주세요' };
  if (req.trigger === 'auto' && !settings.autoCollect) return { ok: true, newMessages: 0, newCards: 0 };

  const state = await collectStateItem.getValue();
  const seen = new Set(state.collectedIds);
  const fresh = req.messages.filter((m) => !seen.has(m.id));
  if (!fresh.length) return { ok: true, newMessages: 0, newCards: 0 };

  const pending = await pendingItem.getValue();
  const topicKeys = [...new Set(pending.map((c) => c.topic_key).filter((k): k is string => !!k))];

  try {
    const { cards, used, nativeError } = await classifyWithFallback(fresh, settings, topicKeys);
    if (nativeError) console.info('[싱크업] 로컬 수집기 연결 실패 → 목업 분류 사용:', nativeError);

    // 개인(personal)은 여기서 버린다. 분류기가 민감정보를 이미 가렸으므로 원문은 남지 않는다.
    const related = cards.filter((c): c is RelatedCard => c.relevance === 'related');
    await pendingItem.setValue([...pending, ...related]);
    await collectStateItem.setValue({
      collectedIds: [...state.collectedIds, ...fresh.map((m) => m.id)].slice(-MAX_REMEMBERED_IDS),
      collectedCount: state.collectedCount + fresh.length,
      lastCollectedAt: new Date().toISOString(),
      lastClassifier: used,
      lastError: null,
    });
    return { ok: true, newMessages: fresh.length, newCards: related.length };
  } catch (e) {
    const error = `분류 실패: ${(e as Error).message}`;
    await collectStateItem.setValue({ ...state, lastError: error });
    return { ok: false, error };
  }
}

async function removePending(ids: string[]) {
  const drop = new Set(ids);
  await pendingItem.setValue((await pendingItem.getValue()).filter((c) => !drop.has(c.id)));
}

const updateBadge = (count: number) => {
  browser.action.setBadgeText({ text: count ? String(count) : '' });
  browser.action.setBadgeBackgroundColor({ color: '#1d4ed8' });
};

// ── 우클릭 메뉴 "싱크업에 선택한 내용 보내기" (자동 추출이 안 될 때 시연용 안전장치) ──
const MENU_ID = 'syncup-send-selection';
const CHAT_PAGES = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

const toastTab = (tabId: number | undefined, toast: Omit<TabToast, 'type'>) => {
  if (tabId !== undefined) browser.tabs.sendMessage(tabId, { type: 'toast', ...toast } satisfies TabToast).catch(() => {});
};

async function sendSelection(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab) {
  const msg = selectionMessage(info.selectionText ?? '', tab?.url ?? info.pageUrl ?? '', tab?.title ?? '');
  if (!msg) return toastTab(tab?.id, { text: '보낼 텍스트를 먼저 드래그해서 선택해 주세요', tone: 'error' });
  const res = await serial(() => collect({ type: 'collect', trigger: 'selection', messages: [msg] }));
  toastTab(
    tab?.id,
    res.ok
      ? { text: res.newMessages ? `보냈어요 · 검토 후보 ${res.newCards}장` : '이미 보낸 내용이에요', tone: 'ok' }
      : { text: res.error, tone: 'error' },
  );
}

export default defineBackground(() => {
  pendingItem.getValue().then((p) => updateBadge(p.length));
  pendingItem.watch((p) => updateBadge(p.length));

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_ID,
      title: '싱크업에 선택한 내용 보내기',
      contexts: ['selection'],
      documentUrlPatterns: CHAT_PAGES,
    });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) void sendSelection(info, tab);
  });

  browser.runtime.onMessage.addListener((msg: BgRequest) => {
    if (msg.type === 'collect') return serial(() => collect(msg));
    if (msg.type === 'removePending') return serial(() => removePending(msg.ids)).then(() => ({ ok: true }));
  });
});
