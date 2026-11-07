// 웹과 연결: 검토 대기 카드·수집 상태를 window.postMessage 로 웹에 넘기고,
// 웹에서 승인/버린 카드는 검토 대기에서 지우며, 웹(대화 수집·팀 만들기 화면)에서 바꾼 설정을 반영한다.
// 형식은 /shared/bridge.ts
import { countTurns } from '@shared/batch';
import { BRIDGE_FROM_EXT, isWebToExt, type ExtStatus, type ExtToWeb } from '@shared/bridge';
import { LOCAL_WEB_URL } from '@/lib/config';
import {
  bufferItem,
  collectStateItem,
  isConfigured,
  pendingItem,
  recentItem,
  settingsItem,
  turnsOf,
  webUrlOf,
} from '@/lib/settings';

export default defineContentScript({
  matches: ['http://localhost:3000/*', 'https://*.vercel.app/*'],
  async main(ctx) {
    // *.vercel.app 은 남의 사이트일 수도 있으므로, 팝업에서 설정한 웹 주소(+로컬 개발 주소)에서만 연결한다
    const allowed = new Set([webUrlOf(await settingsItem.getValue()), LOCAL_WEB_URL]);
    if (!allowed.has(location.origin)) {
      console.info(`[싱크업] 웹 연동 꺼짐: ${location.origin} 은(는) 팝업에 설정한 개인 검토함 주소가 아니에요`);
      return;
    }
    console.info(`[싱크업] 웹 연동 켜짐: ${location.origin}`);

    const post = async () => {
      const [cards, settings, state, buffer, recent] = await Promise.all([
        pendingItem.getValue(),
        settingsItem.getValue(),
        collectStateItem.getValue(),
        bufferItem.getValue(),
        recentItem.getValue(),
      ]);
      if (webUrlOf(settings) !== location.origin && location.origin !== LOCAL_WEB_URL) return; // 도중에 주소를 바꾼 경우
      const status: ExtStatus = {
        version: browser.runtime.getManifest().version,
        configured: isConfigured(settings),
        autoCollect: settings.autoCollect,
        turnsPerBatch: turnsOf(settings),
        bufferedTurns: countTurns(buffer),
        endsAt: settings.endsAt ?? null,
        lastCollectedAt: state.lastCollectedAt,
        lastClassifier: state.lastClassifier,
        teamName: settings.teamName,
        userName: settings.userName,
        recent,
      };
      const msg: ExtToWeb = { source: BRIDGE_FROM_EXT, type: 'pending', cards, userName: settings.userName, status };
      window.postMessage(msg, location.origin);
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== location.origin || !isWebToExt(e.data)) return;
      const msg = e.data;
      if (msg.type === 'hello') void post();
      if (msg.type === 'remove') browser.runtime.sendMessage({ type: 'removePending', ids: msg.ids }).catch(() => {});
      if (msg.type === 'updateSettings') browser.runtime.sendMessage({ type: 'updateSettings', patch: msg.patch }).catch(() => {});
      if (msg.type === 'flush') browser.runtime.sendMessage({ type: 'flush' }).catch(() => {});
    };
    window.addEventListener('message', onMessage);
    // 검토 대기·설정·수집 상태가 바뀌면 웹에 다시 알림
    const unwatch = [pendingItem, settingsItem, collectStateItem, bufferItem, recentItem].map((item) =>
      (item.watch as (cb: () => void) => () => void)(() => void post()),
    );
    void post(); // 웹이 먼저 hello 를 보냈을 수도 있으니 한 번 먼저 알림

    ctx.onInvalidated(() => {
      window.removeEventListener('message', onMessage);
      unwatch.forEach((f) => f());
    });
  },
});
