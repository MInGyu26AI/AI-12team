import { BRIDGE_FROM_EXT, BRIDGE_FROM_WEB } from '@shared/bridge';
import { LOCAL_WEB_URL } from '@/lib/config';
import { settingsItem, webUrlOf } from '@/lib/settings';

export default defineContentScript({
  matches: ['http://localhost:3000/*','http://127.0.0.1:3000/*','https://*.vercel.app/*'],
  async main(ctx) {
    const allowed = async () => [webUrlOf(await settingsItem.getValue()), LOCAL_WEB_URL, 'http://127.0.0.1:3000'].includes(location.origin);
    if (!await allowed()) return;
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
