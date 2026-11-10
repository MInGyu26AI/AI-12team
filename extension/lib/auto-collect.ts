// 자동 수집: "새로" 완료된 메시지만 보낸다. 대화를 열 때 이미 있던 메시지는 기준선으로 보고 보내지 않는다.
import type { ContentScriptContext } from '#imports';
import type { CollectedMessage } from '@shared/collector';
import type { CollectResult } from './messages';
import type { SiteAdapter } from './sites';

const COLLECT_DEBOUNCE_MS = 2000;
const NEW_CHAT_FOLLOW_MS = 500;
const ERROR_TOAST_EVERY_MS = 30_000;

interface AutoCollectOptions {
  site: SiteAdapter;
  overlay: HTMLElement; // 우리 버튼·안내. 이 안의 화면 변화는 무시한다
  isActive: () => boolean; // 자동 수집이 켜져 있고 설정이 끝났는지. 꺼져 있는 동안 보인 메시지는 기준선에 넣는다
  send: (messages: CollectedMessage[]) => Promise<CollectResult>;
  showError: (text: string) => void;
}

// 수집기가 꺼져 있으면 화면이 바뀔 때마다 다시 보내 보되(보내지 못한 메시지를 잃지 않게) 같은 오류 안내는 30초에 한 번만 띄운다.
// 다른 오류는 바로 띄우고, 전송이 성공하면(reset) 다시 처음부터 센다.
function limitErrorToasts(showError: (text: string) => void) {
  let lastText = '';
  let lastShownAt = 0;
  return {
    show(text: string) {
      if (text === lastText && Date.now() - lastShownAt < ERROR_TOAST_EVERY_MS) return;
      lastText = text;
      lastShownAt = Date.now();
      showError(text);
    },
    reset: () => (lastText = ''),
  };
}

/** 화면 변화를 지켜보며 새 메시지를 보낸다. markSeen: 지금(또는 주어진) 메시지를 기준선에 넣어 자동으로 보내지 않게 한다 */
export function startAutoCollect(ctx: ContentScriptContext, { site, overlay, isActive, send, showError }: AutoCollectOptions) {
  const baseline = new Set<string>();
  let baselinePath: string | null = null;
  // 새 채팅 화면(주소에 대화 id 가 아직 없음)에서 기준선 뒤에 나타난 메시지: 첫 글과 개수. ChatGPT 는 첫 질문을 보내면 주소를
  // /c/<id> 로 바꾼다. 바뀐 주소의 대화가 이 글로 시작하고, 메시지가 그 개수에서 0.5초에 하나씩만 늘어 왔을 때만 같은 대화로
  // 이어 본다. 홈에서 연 지난 대화는 다른 글로 시작하거나 메시지가 짧은 사이에 여러 개 나타난다
  let newChat: { first: string; count: number } | null = null;
  let followedAt = 0; // 새 채팅의 메시지 개수를 마지막으로 읽은 때
  const errorToast = limitErrorToasts(showError);
  const markSeen = (messages = site.extract().messages) => messages.forEach((m) => baseline.add(m.id));
  const rememberNewChat = () => {
    const fresh = site.extract().messages.filter((m) => !baseline.has(m.id));
    const [first] = fresh;
    followedAt = Date.now();
    if (!first) return;
    // 기억한 첫 글이 화면에서 사라졌으면(보내기 실패 뒤 다시 쓴 새 채팅 등) 지금 보이는 첫 글로 바꾼다
    const remembered = newChat?.first;
    const kept = remembered !== undefined && fresh.some((m) => m.text === remembered) ? remembered : first.text;
    newChat = { first: kept, count: fresh.length };
  };
  const continuesNewChat = (messages: CollectedMessage[]) =>
    newChat !== null && messages[0]?.text === newChat.first && messages.length <= newChat.count + 1;
  // 주소가 /c/<id> 로 바뀐 뒤 처음 보낼 때까지 개수를 따라간다. 첫 답이 끝나자마자 다음 질문을 보내면 화면이 2초 동안
  // 조용해지기 전에 메시지가 셋 이상이 된다. 0.5초에 한 번만 읽고 한 번에 하나만 올린다: 답이 생성되는 동안 화면 변화마다
  // 대화를 다시 읽지 않고, 짧은 사이에 이어서 그려지는 지난 대화는 따라가지 않는다
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  const followNewChat = () => {
    if (!newChat || baselinePath === location.pathname || !site.isConversationPage()) return;
    const wait = followedAt + NEW_CHAT_FOLLOW_MS - Date.now();
    if (wait > 0) {
      // 건너뛴 화면 변화가 마지막이었어도 한 번은 읽는다 (답이 끝난 뒤 화면이 조용하면 그 답을 세지 못한다)
      followTimer ??= setTimeout(() => {
        followTimer = undefined;
        followNewChat();
      }, wait);
      return;
    }
    followedAt = Date.now();
    const { messages } = site.extract();
    if (newChat && continuesNewChat(messages)) newChat.count = Math.max(newChat.count, messages.length);
  };

  const sendFresh = async () => {
    const { messages } = site.extract();
    if (baselinePath !== location.pathname) {
      const sameChat = site.isConversationPage() && continuesNewChat(messages);
      baselinePath = location.pathname;
      newChat = null;
      if (!sameChat) {
        // 대화가 바뀜(SPA 이동) → 지금 보이는 메시지를 기준선으로
        baseline.clear();
        markSeen(messages);
        return;
      }
    }
    // 새 채팅 화면에서는 대화 id 가 생길 때까지 보내지 않는다. id 없이 보내면 서로 다른 새 대화가 한 대화('new')로 묶인다
    if (!site.isConversationPage()) return;
    const fresh = messages.filter((m) => !baseline.has(m.id));
    if (!fresh.length) return;
    const result = await send(fresh);
    if (!result.ok) return errorToast.show(result.error);
    markSeen(fresh);
    errorToast.reset();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver((records) => {
    if (records.every((r) => overlay.contains(r.target))) return;
    if (!isActive()) return markSeen();
    // 처음 기준선을 잡기 전에는 기억하지 않는다 (그때 보이는 메시지는 이번에 쓴 글이 아니다)
    if (baselinePath !== null) {
      if (!site.isConversationPage()) rememberNewChat();
      else if (newChat && baselinePath !== location.pathname) followNewChat();
    }
    clearTimeout(timer);
    timer = setTimeout(() => void sendFresh(), COLLECT_DEBOUNCE_MS);
  });
  ctx.setTimeout(() => {
    baselinePath = location.pathname;
    newChat = null;
    markSeen();
  }, COLLECT_DEBOUNCE_MS);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  ctx.onInvalidated(() => observer.disconnect());
  return { markSeen };
}
