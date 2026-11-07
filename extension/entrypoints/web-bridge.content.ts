// 웹 개인 검토함과 연결: 검토 대기 카드를 window.postMessage 로 웹 페이지에 넘기고,
// 웹에서 승인/버린 카드는 검토 대기에서 지운다. 형식은 /shared/bridge.ts
import { BRIDGE_FROM_EXT, isWebToExt, type ExtToWeb } from '@shared/bridge';
import { LOCAL_WEB_URL } from '@/lib/config';
import { pendingItem, settingsItem, webUrlOf } from '@/lib/settings';

export default defineContentScript({
  matches: ['http://localhost:3000/*', 'https://*.vercel.app/*'],
  async main(ctx) {
    // *.vercel.app 은 남의 사이트일 수도 있으므로, 팝업에서 설정한 웹 주소(+로컬 개발 주소)에서만 카드를 넘긴다
    const allowed = new Set([webUrlOf(await settingsItem.getValue()), LOCAL_WEB_URL]);
    if (!allowed.has(location.origin)) {
      console.info(`[싱크업] 웹 연동 꺼짐: ${location.origin} 은(는) 팝업에 설정한 개인 검토함 주소가 아니에요`);
      return;
    }
    console.info(`[싱크업] 웹 연동 켜짐: ${location.origin}`);

    const post = async () => {
      const [cards, settings] = await Promise.all([pendingItem.getValue(), settingsItem.getValue()]);
      if (webUrlOf(settings) !== location.origin && location.origin !== LOCAL_WEB_URL) return; // 도중에 주소를 바꾼 경우
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
