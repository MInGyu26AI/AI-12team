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
import { isConfigured, sendBlockedReason, settingsItem, type Settings } from '@/lib/settings';
import { CHAT_PAGE_MATCHES, siteForHost, type SiteAdapter } from '@/lib/sites';
import { createChatgptApi, isSyncRequest } from '@/lib/sites/chatgpt-api';

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

    // 수집기가 거절할 요청은 보내지 않고 이유를 알린다. 설정을 아직 못 읽었으면 설정 전으로 본다
    const isReady = () => {
      const blocked = sendBlockedReason(settings ?? settingsItem.fallback);
      if (!blocked) return true;
      overlay.showToast(blocked, 'error');
      return false;
    };
    wireSendButtons(site, overlay, isReady, autoCollect.markSeen);
    listenForSync(site);
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

// 팝업의 상태 확인(ping)과 백그라운드의 화면 안내(toast). ping 은 sendResponse 로 바로 답한다
// (Promise 를 돌려주는 답은 Chrome 148 미만에서 팝업에 닿지 않는다). toast 는 답하지 않는다
function listenForPingAndToast(site: SiteAdapter, overlay: ChatOverlay) {
  browser.runtime.onMessage.addListener((msg: TabPing | TabToast, _sender, sendResponse) => {
    if (msg?.type === 'toast') overlay.showToast(msg.text, msg.tone);
    if (msg?.type !== 'ping') return;
    const { messages, selector, guessedRoles } = site.extract();
    sendResponse({
      site: site.label,
      onConversation: site.isConversationPage(),
      messageCount: messages.length,
      selector,
      guessedRoles,
    } satisfies TabPingResult);
  });
}

// 계정 동기화: 백그라운드가 보내는 `sync.*` 요청만 탭 클라이언트(lib/sites/chatgpt-api.ts)로 넘기고 sendResponse 로 답한다
// (ping 과 같은 방식. Promise 를 돌려주는 답은 Chrome 148 미만에서 닿지 않는다). 다른 메시지는 건드리지 않는다
function listenForSync(site: SiteAdapter) {
  if (site.id !== 'chatgpt') return; // 내부 API 주소가 ChatGPT 것이다. 다른 사이트 탭에서는 답하지 않는다
  const api = createChatgptApi();
  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isSyncRequest(msg)) return;
    void api.handle(msg).then(sendResponse);
    return true; // 답을 기다리는 동안 채널을 열어 둔다
  });
}
