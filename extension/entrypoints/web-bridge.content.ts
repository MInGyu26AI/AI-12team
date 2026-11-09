// 개인 검토함 웹 ↔ 로컬 수집기 RPC 중계 (메시지 형식은 shared/bridge.ts).
// 스크립트는 WEB_BRIDGE_MATCHES 전체에 붙지만 팝업에서 설정한 주소의 페이지에만 답한다.
// 주소를 바꾼 뒤 이미 열린 탭도 새로고침 없이 따르도록 메시지마다 확인한다.
// 믿는 페이지에는 요청을 받자마자 rpc-ack 를 먼저 보낸다. 웹은 이 신호가 없으면 확장이 없다고 안내한다.
import { BRIDGE_FROM_EXT, BRIDGE_FROM_WEB } from '@shared/bridge';
import { sendToBackground, type BgResponse } from '@/lib/messages';
import { settingsItem } from '@/lib/settings';
import { WEB_BRIDGE_MATCHES, isTrustedWebOrigin } from '@/lib/web-url';

export default defineContentScript({
  matches: WEB_BRIDGE_MATCHES,
  main(ctx) {
    const receive = async (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== window || event.origin !== location.origin) return;
      if (message?.source !== BRIDGE_FROM_WEB || message.type !== 'rpc') return;
      if (typeof message.id !== 'string' || typeof message.method !== 'string') return;
      if (!isTrustedWebOrigin(await settingsItem.getValue(), location.origin)) return;
      window.postMessage({ source: BRIDGE_FROM_EXT, type: 'rpc-ack', id: message.id }, location.origin);
      const reply = (result: BgResponse) =>
        window.postMessage({ ...result, source: BRIDGE_FROM_EXT, type: 'rpc-result', id: message.id }, location.origin);
      try {
        reply(await sendToBackground({ type: 'rpc', method: message.method, params: message.params }));
      } catch {
        reply({ ok: false, error: '확장 연결 실패' });
      }
    };
    window.addEventListener('message', receive);
    ctx.onInvalidated(() => window.removeEventListener('message', receive));
  },
});
