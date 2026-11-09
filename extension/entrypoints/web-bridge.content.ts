import { BRIDGE_FROM_EXT, BRIDGE_FROM_WEB } from '@shared/bridge';
import { WEB_BRIDGE_MATCHES } from '@/lib/config';
import { isTrustedWebOrigin, settingsItem } from '@/lib/settings';

// 스크립트는 WEB_BRIDGE_MATCHES 전체에 붙지만 팝업에서 설정한 주소의 페이지에만 답한다.
// 주소를 바꾼 뒤 이미 열린 탭도 새로고침 없이 따르도록 메시지마다 확인한다.
export default defineContentScript({
  matches: WEB_BRIDGE_MATCHES,
  main(ctx) {
    const allowed = async () => isTrustedWebOrigin(await settingsItem.getValue(), location.origin);
    const receive = async (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== BRIDGE_FROM_WEB || event.data.type !== 'rpc' || !await allowed()) return;
      const message = event.data;
      if (typeof message.id !== 'string' || typeof message.method !== 'string') return;
      try {
        const result = await browser.runtime.sendMessage({ type: 'rpc', method: message.method, params: message.params });
        window.postMessage({ ...result, source: BRIDGE_FROM_EXT, type: 'rpc-result', id: message.id }, location.origin);
      } catch {
        window.postMessage({ source: BRIDGE_FROM_EXT, type: 'rpc-result', id: message.id, ok: false, error: '확장 연결 실패' }, location.origin);
      }
    };
    window.addEventListener('message', receive);
    ctx.onInvalidated(() => window.removeEventListener('message', receive));
  },
});
