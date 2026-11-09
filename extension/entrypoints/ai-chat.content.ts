// AI 채팅 사이트 콘텐츠 스크립트: 대화 추출 → 백그라운드로 전달. 사이트별 차이는 lib/sites/* 에.
import type { CollectedMessage } from '@shared/collector';
import { COLLECT_DEBOUNCE_MS } from '@/lib/config';
import { READ_FAIL_GUIDE, type BgRequest, type CollectResult, type TabPing, type TabPingResult, type TabToast } from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import { isConfigured, settingsItem, type Settings } from '@/lib/settings';
import { siteForHost } from '@/lib/sites';

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  main(ctx) {
    const site = siteForHost(location.hostname);
    if (!site) return;

    let settings: Settings | null = null;
    settingsItem.getValue().then((s) => (settings = s));
    settingsItem.watch((s) => {
      if (!settings?.autoCollect || !s.autoCollect) site.extract().messages.forEach(m => baseline.add(m.id));
      settings = s;
    });

    const request = async (msg: BgRequest): Promise<CollectResult> => {
      try {
        return (await browser.runtime.sendMessage(msg)) as CollectResult;
      } catch {
        // 확장을 새로 고친 뒤 이전 콘텐츠 스크립트가 남아 있는 경우
        return { ok: false, error: '확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요' };
      }
    };

    // ── 자동 수집: "새로" 완료된 메시지만. 대화를 열 때 이미 있던 메시지는 기준선으로 보고 보내지 않는다 ──
    const baseline = new Set<string>();
    let baselinePath: string | null = null;
    // 수집기가 꺼져 있으면 화면이 바뀔 때마다 다시 보내 보되(보내지 못한 메시지를 잃지 않게) 같은 오류 안내는 30초에 한 번만 띄운다.
    // 다른 오류는 바로 띄우고, 전송이 성공하면 다시 처음부터 센다.
    const ERROR_TOAST_EVERY_MS = 30_000;
    let lastErrorToast = 0;
    let lastErrorText = '';

    const autoSend = async () => {
      const { messages } = site.extract();
      if (baselinePath !== location.pathname) {
        // 대화가 바뀜(SPA 이동) → 지금 보이는 메시지를 기준선으로
        baselinePath = location.pathname;
        baseline.clear();
        messages.forEach((m) => baseline.add(m.id));
        return;
      }
      const fresh = messages.filter((m) => !baseline.has(m.id));
      if (fresh.length) {
        const result = await request({ type: 'collect', trigger: 'auto', messages: fresh });
        if (result.ok) {
          fresh.forEach(m => baseline.add(m.id));
          lastErrorText = '';
        } else if (result.error !== lastErrorText || Date.now() - lastErrorToast >= ERROR_TOAST_EVERY_MS) {
          lastErrorText = result.error;
          lastErrorToast = Date.now();
          showToast(result.error, 'error');
        }
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver((records) => {
      if (records.every((r) => host.contains(r.target))) return; // 우리 버튼 변화는 무시
      if (!settings?.autoCollect || !isConfigured(settings)) {
        site.extract().messages.forEach(m => baseline.add(m.id));
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void autoSend(), COLLECT_DEBOUNCE_MS);
    });
    ctx.setTimeout(() => {
      baselinePath = location.pathname;
      site.extract().messages.forEach((m) => baseline.add(m.id));
    }, COLLECT_DEBOUNCE_MS);

    // ── 화면 UI (shadow DOM 으로 ChatGPT 스타일과 분리) ──
    const host = document.createElement('div');
    host.id = 'syncup-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 20px; bottom: 96px; z-index: 2147483646; display: flex; flex-direction: column;
                align-items: flex-end; gap: 6px; font: 600 13px/1.3 "Pretendard Variable", Pretendard, system-ui, sans-serif; }
        button { border: 1px solid rgba(0,0,0,.08); border-radius: 9999px; padding: 8px 12px; cursor: pointer; color: #fff;
                 background: #1d4ed8; box-shadow: 0 4px 12px rgba(0,0,0,.15); font: inherit; opacity: .94; }
        button.sel { background: #fff; color: #1d4ed8; border-color: #1d4ed8; }
        button:disabled { opacity: .45; cursor: default; }
        .toast { max-width: 280px; padding: 8px 12px; border-radius: 10px; color: #fff; font-weight: 500;
                 box-shadow: 0 4px 12px rgba(0,0,0,.15); display: none; }
        .toast.ok { background: #0f766e; } .toast.error { background: #b91c1c; } .toast.show { display: block; }
      </style>
      <div class="wrap">
        <div class="toast" role="status"></div>
        <button type="button" class="sel" disabled>선택한 내용 보내기</button>
        <button type="button" class="all">싱크업에 보내기</button>
      </div>`;
    const toast = shadow.querySelector<HTMLDivElement>('.toast')!;
    const allBtn = shadow.querySelector<HTMLButtonElement>('button.all')!;
    const selBtn = shadow.querySelector<HTMLButtonElement>('button.sel')!;

    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    const showToast = (text: string, tone: 'ok' | 'error') => {
      toast.textContent = text;
      toast.className = `toast show ${tone}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.className = 'toast'), tone === 'error' ? 6000 : 3000);
    };

    const reportResult = (res: CollectResult) => {
      if (!res.ok) return showToast(res.error, 'error');
      showToast(res.newMessages ? '분류 대기함에 저장했어요. 승인함에서 결과를 확인하세요.' : '이미 보낸 내용이에요', 'ok');
    };

    const needSetup = () => {
      if (settings && isConfigured(settings)) return false;
      showToast('확장 아이콘을 눌러 먼저 설정해 주세요', 'error');
      return true;
    };

    // 수동: 화면에 보이는 대화 전체 (백그라운드에서 중복 제거)
    allBtn.addEventListener('click', async () => {
      if (needSetup()) return;
      const { messages } = site.extract();
      if (!messages.length) return showToast(READ_FAIL_GUIDE, 'error');
      messages.forEach((m) => baseline.add(m.id));
      allBtn.disabled = true;
      reportResult(await request({ type: 'collect', trigger: 'manual', messages }));
      allBtn.disabled = false;
    });

    // 드래그 선택: 버튼을 누를 때 선택이 풀리지 않게 mousedown 기본 동작을 막는다
    let selected = '';
    document.addEventListener('selectionchange', () => {
      selected = window.getSelection()?.toString().trim() ?? '';
      selBtn.disabled = selected.length < 2;
    });
    selBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selBtn.addEventListener('click', async () => {
      if (needSetup()) return;
      const msg: CollectedMessage | null = selectionMessage(selected, location.href, document.title);
      if (!msg) return showToast('보낼 텍스트를 먼저 드래그해서 선택해 주세요', 'error');
      selBtn.disabled = true;
      reportResult(await request({ type: 'collect', trigger: 'selection', messages: [msg] }));
      selBtn.disabled = selected.length < 2;
    });

    // ── 팝업 상태 확인 · 백그라운드 안내 ──
    browser.runtime.onMessage.addListener((msg: TabPing | TabToast) => {
      if (msg?.type === 'toast') {
        showToast(msg.text, msg.tone);
        return;
      }
      if (msg?.type !== 'ping') return;
      const { messages, selector, guessedRoles } = site.extract();
      return Promise.resolve<TabPingResult>({
        site: site.label,
        onConversation: site.isConversationPage(),
        messageCount: messages.length,
        selector,
        guessedRoles,
      });
    });

    document.body.append(host);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    ctx.onInvalidated(() => {
      observer.disconnect();
      host.remove();
    });
  },
});
