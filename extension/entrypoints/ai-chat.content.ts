// AI 채팅 사이트 콘텐츠 스크립트: 대화 추출 → 백그라운드로 전달. 사이트별 차이는 lib/sites/* 에.
import { COLLECT_DEBOUNCE_MS } from '@/lib/config';
import type { CollectResult, TabPing, TabPingResult } from '@/lib/messages';
import { isConfigured, settingsItem, type Settings } from '@/lib/settings';
import { siteForHost } from '@/lib/sites';

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  main(ctx) {
    const site = siteForHost(location.hostname);
    if (!site) return;

    let settings: Settings | null = null;
    settingsItem.getValue().then((s) => (settings = s));
    settingsItem.watch((s) => (settings = s));

    // 자동 수집은 "새로" 완료된 메시지만: 대화를 열 때 이미 있던 메시지는 기준선으로 보고 보내지 않는다
    const baseline = new Set<string>();
    let baselinePath: string | null = null;

    const send = async (trigger: 'auto' | 'manual') => {
      const { messages } = site.extract();
      if (trigger === 'auto') {
        if (baselinePath !== location.pathname) {
          // 대화가 바뀜(SPA 이동) → 지금 보이는 메시지를 기준선으로
          baselinePath = location.pathname;
          baseline.clear();
          messages.forEach((m) => baseline.add(m.id));
          return null;
        }
        const fresh = messages.filter((m) => !baseline.has(m.id));
        fresh.forEach((m) => baseline.add(m.id));
        if (!fresh.length) return null;
        return request({ type: 'collect', trigger, messages: fresh });
      }
      // 수동: 화면에 보이는 대화 전체 (백그라운드에서 중복 제거)
      messages.forEach((m) => baseline.add(m.id));
      return request({ type: 'collect', trigger, messages });
    };

    const request = async (msg: { type: 'collect'; trigger: 'auto' | 'manual'; messages: unknown[] }) => {
      try {
        return (await browser.runtime.sendMessage(msg)) as CollectResult;
      } catch {
        // 확장을 새로 고친 뒤 이전 콘텐츠 스크립트가 남아 있는 경우
        return { ok: false, error: '확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요' } as CollectResult;
      }
    };

    // ── 자동 수집: MutationObserver + 디바운스 2초 ──
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (!settings?.autoCollect || !isConfigured(settings)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void send('auto'), COLLECT_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    // 페이지를 연 시점의 대화를 기준선으로 잡아 둠
    ctx.setTimeout(() => {
      baselinePath = location.pathname;
      site.extract().messages.forEach((m) => baseline.add(m.id));
    }, COLLECT_DEBOUNCE_MS);

    // ── 팝업 상태 확인용 ──
    browser.runtime.onMessage.addListener((msg: TabPing) => {
      if (msg?.type !== 'ping') return;
      const { messages, selector } = site.extract();
      return Promise.resolve<TabPingResult>({
        site: site.label,
        onConversation: site.isConversationPage(),
        messageCount: messages.length,
        selector,
      });
    });

    // ── 오른쪽 아래 "싱크업에 보내기" 버튼 (수동 수집) ──
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '싱크업에 보내기';
    Object.assign(button.style, {
      position: 'fixed',
      right: '20px',
      bottom: '96px',
      zIndex: '2147483646',
      padding: '8px 12px',
      borderRadius: '9999px',
      border: '1px solid rgba(0,0,0,.1)',
      background: '#1d4ed8',
      color: '#fff',
      font: '600 13px/1.2 "Pretendard Variable", Pretendard, system-ui, sans-serif',
      boxShadow: '0 4px 12px rgba(0,0,0,.15)',
      cursor: 'pointer',
      opacity: '0.92',
    } satisfies Partial<CSSStyleDeclaration>);

    const flash = (text: string, ok: boolean) => {
      button.textContent = text;
      button.style.background = ok ? '#0f766e' : '#b91c1c';
      ctx.setTimeout(() => {
        button.textContent = '싱크업에 보내기';
        button.style.background = '#1d4ed8';
      }, 2500);
    };

    button.addEventListener('click', async () => {
      if (!settings || !isConfigured(settings)) return flash('팝업에서 먼저 설정해 주세요', false);
      const { messages } = site.extract();
      if (!messages.length) return flash('대화를 못 읽었어요', false);
      button.textContent = '보내는 중…';
      const res = await send('manual');
      if (!res) return flash('보낼 새 메시지가 없어요', true);
      if (!res.ok) return flash(res.error, false);
      flash(res.newMessages ? `보냈어요 · 후보 ${res.newCards}장` : '이미 보낸 대화예요', true);
    });

    document.body.append(button);
    ctx.onInvalidated(() => {
      observer.disconnect();
      button.remove();
    });
  },
});
