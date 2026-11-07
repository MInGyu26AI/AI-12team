// 웹 개인 검토함과 연결: 검토 대기 카드를 window.postMessage 로 웹 페이지에 넘기고,
// 웹에서 승인/버린 카드는 검토 대기에서 지운다. 형식은 /shared/bridge.ts
import { BRIDGE_FROM_EXT, isWebToExt, type ExtToWeb } from '@shared/bridge';
import { BRIDGE_ORIGINS } from '@/lib/config';
import { pendingItem, settingsItem } from '@/lib/settings';

export default defineContentScript({
  matches: ['http://localhost:3000/*', 'https://*.vercel.app/*'],
  main(ctx) {
    // *.vercel.app 은 남의 사이트일 수도 있으므로, 설정한 웹 주소에서만 카드를 넘긴다
    if (!BRIDGE_ORIGINS.includes(location.origin)) return;

    const post = async () => {
      const [cards, settings] = await Promise.all([pendingItem.getValue(), settingsItem.getValue()]);
      const msg: ExtToWeb = { source: BRIDGE_FROM_EXT, type: 'pending', cards, userName: settings.userName };
      window.postMessage(msg, location.origin);
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin || !isWebToExt(e.data)) return;
      if (e.data.type === 'hello') void post();
      if (e.data.type === 'remove') {
        browser.runtime.sendMessage({ type: 'removePending', ids: e.data.ids }).catch(() => {});
      }
    };
    window.addEventListener('message', onMessage);
    const unwatch = pendingItem.watch(() => void post()); // 검토 대기가 바뀌면 웹에 다시 알림
    void post(); // 웹이 먼저 hello 를 보냈을 수도 있으니 한 번 먼저 알림

    ctx.onInvalidated(() => {
      window.removeEventListener('message', onMessage);
      unwatch();
    });
  },
});
