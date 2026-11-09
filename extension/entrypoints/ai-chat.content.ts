// AI 채팅 사이트 콘텐츠 스크립트: 대화 추출 → 백그라운드로 전달. 사이트별 차이는 lib/sites/* 에.
import type { CollectedMessage } from '@shared/collector';
import { startAutoCollect } from '@/lib/auto-collect';
import { createChatOverlay, type ChatOverlay } from '@/lib/chat-overlay';
import {
  READ_FAIL_GUIDE,
  collectResultToast,
  sendToBackground,
  type BgRequest,
  type CollectResult,
  type TabPing,
  type TabPingResult,
  type TabToast,
} from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import { isConfigured, settingsItem, type Settings } from '@/lib/settings';
import { CHAT_PAGE_MATCHES, siteForHost, type SiteAdapter } from '@/lib/sites';

type Trigger = Extract<BgRequest, { type: 'collect' }>['trigger'];

async function sendCollect(trigger: Trigger, messages: CollectedMessage[]): Promise<CollectResult> {
  try {
    return await sendToBackground<CollectResult>({ type: 'collect', trigger, messages });
  } catch {
    // 확장을 새로 고친 뒤 이전 콘텐츠 스크립트가 남아 있는 경우
    return { ok: false, error: '확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요' };
  }
}

export default defineContentScript({
  matches: CHAT_PAGE_MATCHES,
  main(ctx) {
    const site = siteForHost(location.hostname);
    if (!site) return;

    let settings: Settings | null = null;
    const overlay = createChatOverlay();
    // 우리 버튼을 먼저 붙이고 나서 화면 변화를 지켜본다 (붙이는 것 자체는 화면 변화로 세지 않게)
    document.body.append(overlay.host);
    const autoCollect = startAutoCollect(ctx, {
      site,
      overlay: overlay.host,
      isActive: () => !!settings?.autoCollect && isConfigured(settings),
      send: (messages) => sendCollect('auto', messages),
      showError: (text) => overlay.showToast(text, 'error'),
    });
    ctx.onInvalidated(() => overlay.host.remove());

    settingsItem.getValue().then((s) => (settings = s));
    settingsItem.watch((s) => {
      if (!settings?.autoCollect || !s.autoCollect) autoCollect.markSeen();
      settings = s;
    });

    const isReady = () => {
      if (settings && isConfigured(settings)) return true;
      overlay.showToast('확장 아이콘을 눌러 먼저 설정해 주세요', 'error');
      return false;
    };
    wireSendButtons(site, overlay, isReady, autoCollect.markSeen);
    listenForPingAndToast(site, overlay);
  },
});

function wireSendButtons(site: SiteAdapter, overlay: ChatOverlay, isReady: () => boolean, markSeen: (m: CollectedMessage[]) => void) {
  const { sendAllButton, sendSelectionButton, showToast } = overlay;
  const report = (result: CollectResult) => {
    const toast = collectResultToast(result);
    showToast(toast.text, toast.tone);
  };

  // 수동: 화면에 보이는 대화 전체 (이미 보낸 메시지는 로컬 수집기가 id 로 거른다)
  sendAllButton.addEventListener('click', async () => {
    if (!isReady()) return;
    const { messages } = site.extract();
    if (!messages.length) return showToast(READ_FAIL_GUIDE, 'error');
    markSeen(messages);
    sendAllButton.disabled = true;
    report(await sendCollect('manual', messages));
    sendAllButton.disabled = false;
  });

  // 드래그 선택: 버튼을 누를 때 선택이 풀리지 않게 mousedown 기본 동작을 막는다
  let selected = '';
  document.addEventListener('selectionchange', () => {
    selected = window.getSelection()?.toString().trim() ?? '';
    sendSelectionButton.disabled = selected.length < 2;
  });
  sendSelectionButton.addEventListener('mousedown', (e) => e.preventDefault());
  sendSelectionButton.addEventListener('click', async () => {
    if (!isReady()) return;
    const message = selectionMessage(site, selected, location.href, document.title);
    if (!message) return showToast('보낼 텍스트를 먼저 드래그해서 선택해 주세요', 'error');
    sendSelectionButton.disabled = true;
    report(await sendCollect('selection', [message]));
    sendSelectionButton.disabled = selected.length < 2;
  });
}

// 팝업의 상태 확인(ping)과 백그라운드의 화면 안내(toast)
function listenForPingAndToast(site: SiteAdapter, overlay: ChatOverlay) {
  browser.runtime.onMessage.addListener((msg: TabPing | TabToast) => {
    if (msg?.type === 'toast') {
      overlay.showToast(msg.text, msg.tone);
      return;
    }
    if (msg?.type !== 'ping') return;
    const { messages, selector, guessedRoles } = site.extract();
    return Promise.resolve<TabPingResult>({
      site: site.label,
      onConversation: site.isConversationPage(),
      messageCount: messages.length,
      selector,
      guessedRoles,
    });
  });
}
