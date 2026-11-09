// 자동 수집: "새로" 완료된 메시지만 보낸다. 대화를 열 때 이미 있던 메시지는 기준선으로 보고 보내지 않는다.
import type { ContentScriptContext } from '#imports';
import type { CollectedMessage } from '@shared/collector';
import type { CollectResult } from './messages';
import type { SiteAdapter } from './sites';

const COLLECT_DEBOUNCE_MS = 2000;
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
  const errorToast = limitErrorToasts(showError);
  const markSeen = (messages = site.extract().messages) => messages.forEach((m) => baseline.add(m.id));

  const sendFresh = async () => {
    const { messages } = site.extract();
    if (baselinePath !== location.pathname) {
      // 대화가 바뀜(SPA 이동) → 지금 보이는 메시지를 기준선으로
      baselinePath = location.pathname;
      baseline.clear();
      markSeen(messages);
      return;
    }
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
    clearTimeout(timer);
    timer = setTimeout(() => void sendFresh(), COLLECT_DEBOUNCE_MS);
  });
  ctx.setTimeout(() => {
    baselinePath = location.pathname;
    markSeen();
  }, COLLECT_DEBOUNCE_MS);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  ctx.onInvalidated(() => observer.disconnect());
  return { markSeen };
}
