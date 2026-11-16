import { mountLucianIcons } from './lucian-overlay-icons';
import type { SyncNowResult } from '@shared/bridge';
import { sendToBackground, type BgResponse, type TabToast } from './messages';
import { EXTENSION_UPDATED_GUIDE, deliverTeamRecord, loadTeamRecord, type TeamRecordSource } from './team-record';

// 대화 작업은 바로 표시하고 지금까지 모은 대화 넣기는 더 보기에 둔다. 기존 수집 경로는 유지한다.
const icon = (name: string) => `<span data-lucian="${name}" animate="none" aria-hidden="true"></span>`;
const tool = (cls: string, label: string, detail: string, paths: string, disabled = false) => `
  <div class="tool">
    <button type="button" class="${cls}" aria-label="${label}" aria-describedby="tip-${cls}" ${disabled ? 'disabled' : ''}>${icon(paths)}</button>
    <span class="tip" id="tip-${cls}" role="tooltip"><strong>${label}</strong><span>${detail}</span></span>
  </div>`;
const TEMPLATE = `
  <style>
    :host { all: initial; }
    .wrap { position: fixed; right: 20px; bottom: 96px; z-index: 2147483646; display: flex; flex-direction: column;
      align-items: flex-end; gap: 8px; font: 500 13px/1.5 "Pretendard Variable", Pretendard, system-ui, sans-serif; }
    details { position: relative; }
    summary { list-style: none; display: grid; place-items: center; width: 44px; height: 44px; box-sizing: border-box;
      border: 1px solid #dbe3f2; border-radius: 14px; color: #3159c9; background: #fff; cursor: pointer; box-shadow: 0 3px 12px #0002; }
    summary::-webkit-details-marker { display: none; }
    summary:focus-visible { outline: 3px solid #93b4ff; outline-offset: 3px; }

    .maintenance { position: absolute; right: 54px; bottom: 0; width: 260px; max-width: calc(100vw - 98px);
      box-sizing: border-box; padding: 14px; border-radius: 14px; background: #fff; color: #172033; box-shadow: 0 6px 24px #0003; }
    .maintenance p { margin: 0 0 10px; font-size: 12px; }
    .maintenance button { width: 100%; display: flex; gap: 8px; justify-content: center; font-size: 13px; }
    .maintenance .tip { display: none; }
    .tool { position: relative; padding: 3px; margin: -3px; }
    button { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 1px solid #dbe3f2;
      border-radius: 14px; cursor: pointer; color: #3159c9; background: #fff; box-shadow: 0 3px 12px #0002; font: inherit; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    button:disabled { opacity: .35; cursor: default; }
    .wrap { color: light-dark(#20232a, #ffffff); } /* 다크 모드 아이콘은 흰색 */
    button, summary { width: 48px; height: 48px; border: 0; border-radius: 0; background: transparent;
      color: inherit; box-shadow: none; }
    summary:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .maintenance { color: light-dark(#20232a, #eceef4); background: light-dark(#fff, #232428); }
    .tip { position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%); width: 244px;
      max-width: calc(100vw - 98px); box-sizing: border-box; padding: 11px 14px; border-radius: 12px; background: #172033;
      color: #fff; box-shadow: 0 6px 24px #0003; opacity: 0; visibility: hidden; transition: opacity .12s; pointer-events: none; }
    .tip strong, .tip span { display: block; } .tip strong { font-weight: 650; margin-bottom: 4px; }
    .tip::after { content: ''; position: absolute; left: 100%; top: 0; width: 14px; height: 100%; }
    .tip span { color: #d4def0; font-size: 12px; font-weight: 400; }
    .tool:hover .tip, .tool:focus-within .tip { opacity: 1; visibility: visible; pointer-events: auto; }
    .tool.dismissed .tip { opacity: 0; visibility: hidden; }
    .toast { max-width: min(280px, calc(100vw - 40px)); padding: 10px 14px; border-radius: 12px; color: #fff;
      font-weight: 500; box-shadow: 0 4px 12px #0003; display: none; }
    .toast.ok { background: #0f766e; } .toast.error { background: #b91c1c; } .toast.show { display: block; }
    @media (prefers-reduced-motion: reduce) { .tip { transition: none; } }
  </style>
  <div class="wrap" aria-label="SyncUp 대화 도구">
    <div class="toast" role="status" aria-live="polite"></div>
    ${tool('record', '팀 기록 불러오기', '팀의 결정과 충돌을 이 입력창에 넣어요. AI에게 자동으로 전송하지 않아요.', 'book')}
    ${tool('sel', '선택한 내용 넣기', '드래그한 글에서 개인 승인함의 검토 후보를 만들어요. 먼저 글을 선택하고 수집을 켜 주세요. 승인 전에는 팀에 공유하지 않아요.', 'cursor', true)}
    ${tool('all', '이 대화 넣기', '현재 열린 대화에서 화면에 불러온 내용을 처리해요. 개인 승인함에 검토 후보가 생기며, 승인 후 팀에 공유돼요. 자동 수집 중인 프로젝트는 더 보기의 ‘지금까지 모은 대화 넣기’를 사용하세요.', 'document')}
    <details class="more">
      <summary aria-label="더 보기 · 수집 관리" title="더 보기 · 수집 관리">${icon('more')}</summary>
      <div class="maintenance">
        <p><strong>수집 관리</strong></p>
        <p>자동 수집을 기다리지 않고 지금 처리할 때 사용하세요.</p>
        <p id="queue-scope">연결한 프로젝트의 새 대화를 확인하고, 수집함에 쌓인 대화를 처리해요. 다른 대화의 대기분도 포함돼요. 프로젝트 연결이 꺼져 있으면 쌓인 대화만 처리해요.</p>
    ${tool('sync', '지금까지 모은 대화 넣기', '연결한 프로젝트의 새 대화를 확인한 뒤, 수집함에 쌓인 대화를 처리해요. 프로젝트 연결이 꺼져 있으면 쌓인 대화만 처리해요.', 'refresh')}
      </div>
    </details>
  </div>`;

export interface ChatOverlay {
  host: HTMLElement; // 페이지에 붙일 뿌리 요소. 이 안의 화면 변화는 자동 수집이 무시한다
  sendAllButton: HTMLButtonElement;
  sendSelectionButton: HTMLButtonElement;
  syncButton: HTMLButtonElement; // 싱크 맞추기: 클릭 처리는 createChatOverlay 가 이미 연결한다
  recordButton: HTMLButtonElement; // 팀 기록 불러오기: 클릭 처리는 createChatOverlay 가 이미 연결한다
  showToast(text: string, tone: TabToast['tone']): void;
}

export interface OverlayActions {
  /** 팀 보드 카드·충돌을 받아 오는 함수. 백그라운드 연결은 ai-chat.content.ts 에서 넘긴다. 없으면 '팀 기록 불러오기'는 연결 전이라고만 안내한다 */
  fetchTeamRecord?: TeamRecordSource;
}

const NO_RECORD_SOURCE_GUIDE = '팀 기록을 받아 올 연결이 아직 없어요';

/** '싱크 맞추기' 결과(SyncNowResult)를 화면 안내로. 패스 결과와 분류 시작 여부를 한 줄에 담는다 */
export function syncNowToast(result: SyncNowResult): { text: string; tone: TabToast['tone'] } {
  const pass: Record<SyncNowResult['sync'], string> = {
    ran: result.newTurns > 0 ? `새 대화 ${result.newTurns}턴을 가져왔어요` : '새로 가져올 대화가 없어요',
    off: '프로젝트 동기화가 꺼져 있어요',
    resting: 'ChatGPT 요청 제한으로 쉬는 중이에요. 잠시 뒤에 다시 눌러 주세요',
    'no-tab': 'chatgpt.com 탭을 하나 열어 두세요',
    busy: '이미 동기화하는 중이에요',
    failed: '동기화하지 못했어요. 팝업에서 상태를 확인해 주세요',
  };
  const classify = result.flushed ? '분류를 시작했어요' : result.blockedReason;
  const failed = result.sync === 'failed' || result.sync === 'no-tab' || result.sync === 'resting';
  return { text: [pass[result.sync], classify].filter(Boolean).join(' · '), tone: failed || !!result.blockedReason ? 'error' : 'ok' };
}

export function createChatOverlay(actions: OverlayActions = {}): ChatOverlay {
  const host = document.createElement('div');
  host.id = 'syncup-root';
  const shadow = host.attachShadow({ mode: 'open' });
  // Match the page theme, including ChatGPT's explicit dark class. No animation timer.
  // ChatGPT 는 화면을 그린 뒤에 dark 클래스를 붙이기도 해서, 한 번만 보면 다크 화면에서도 밝은 화면용 진한 아이콘이 남는다.
  // 그래서 <html> 의 class·style·color-scheme 이 바뀔 때와 OS 설정이 바뀔 때 다시 맞춘다 (아이콘 모양·애니메이션은 그대로)
  const updateTheme = () => {
    const root = document.documentElement;
    const scheme = getComputedStyle(root).colorScheme;
    host.style.colorScheme = root.classList.contains('dark') ? 'dark' : root.classList.contains('light') ? 'light' : scheme || 'light dark';
  };
  updateTheme();
  new MutationObserver(updateTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', updateTheme);
  shadow.innerHTML = TEMPLATE;
  mountLucianIcons(shadow);
  // The vendor's default hover also includes keyboard/touch. Disable those bindings
  // and explicitly play once per mouse entry; never on click, focus, or a timer.
  shadow.querySelectorAll<HTMLButtonElement | HTMLElement>('button, summary').forEach((control) => {
    control.addEventListener('pointerenter', (event) => {
      if ((event as PointerEvent).pointerType !== 'mouse' || control.matches(':disabled')) return;
      const glyph = control.querySelector<HTMLElement & { play(): boolean }>('[animate="none"]');
      glyph?.play();
    });
  });
  shadow.querySelectorAll<HTMLDivElement>('.tool').forEach((wrapper) => {
    const button = wrapper.querySelector('button')!;
    const updateFocus = () => { wrapper.tabIndex = button.disabled ? 0 : -1; };
    updateFocus();
    new MutationObserver(updateFocus).observe(button, { attributes: true, attributeFilter: ['disabled'] });
    wrapper.addEventListener('keydown', (event) => { if (event.key === 'Escape') wrapper.classList.add('dismissed'); });
    wrapper.addEventListener('mouseleave', () => wrapper.classList.remove('dismissed'));
    wrapper.addEventListener('focusout', () => wrapper.classList.remove('dismissed'));
  });
  const toast = shadow.querySelector<HTMLDivElement>('.toast')!;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const overlay: ChatOverlay = {
    host,
    sendAllButton: shadow.querySelector<HTMLButtonElement>('button.all')!,
    sendSelectionButton: shadow.querySelector<HTMLButtonElement>('button.sel')!,
    syncButton: shadow.querySelector<HTMLButtonElement>('button.sync')!,
    recordButton: shadow.querySelector<HTMLButtonElement>('button.record')!,
    showToast(text, tone) {
      toast.textContent = text;
      toast.className = `toast show ${tone}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.className = 'toast'), tone === 'error' ? 6000 : 3000);
    },
  };
  overlay.syncButton.insertAdjacentHTML('beforeend', '<span>지금까지 모은 대화 넣기</span>');
  overlay.syncButton.setAttribute('aria-describedby', 'queue-scope');
  const more = shadow.querySelector<HTMLDetailsElement>('.more')!;
  more.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { more.open = false; more.querySelector('summary')!.focus(); }
  });
  wireSyncButton(overlay);
  wireRecordButton(overlay, actions.fetchTeamRecord);
  return overlay;
}

// 싱크 맞추기: 백그라운드가 프로젝트 동기화 패스를 바로 돌리고(켜져 있을 때) 수집 중이면 분류까지 시작한다
function wireSyncButton({ syncButton, showToast }: ChatOverlay) {
  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true;
    showToast('새 대화와 수집 대기분을 확인하고 있어요…', 'ok');
    try {
      const response = await sendToBackground<BgResponse | undefined>({ type: 'syncNow', params: { reason: 'button' } });
      if (!response) return showToast(EXTENSION_UPDATED_GUIDE, 'error');
      if (!response.ok) return showToast(response.error, 'error');
      const result = response.result as SyncNowResult | undefined;
      if (typeof result?.sync !== 'string') return showToast('동기화 결과를 읽지 못했어요', 'error');
      const toast = syncNowToast(result);
      showToast(toast.text, toast.tone);
    } catch {
      // 확장을 새로 고친 뒤 이전 콘텐츠 스크립트가 남아 있는 경우
      showToast(EXTENSION_UPDATED_GUIDE, 'error');
    } finally {
      syncButton.disabled = false;
    }
  });
}

// 팀 기록 불러오기: 팀 보드를 마크다운으로 입력창에 채운다(전송은 사용자). 입력창을 못 채우면 클립보드에 복사한다
function wireRecordButton({ recordButton, showToast }: ChatOverlay, fetchTeamRecord: TeamRecordSource | undefined) {
  recordButton.addEventListener('click', async () => {
    if (!fetchTeamRecord) return showToast(NO_RECORD_SOURCE_GUIDE, 'error');
    recordButton.disabled = true;
    try {
      const record = await loadTeamRecord(fetchTeamRecord);
      if (!record.ok) return showToast(record.error, 'error');
      const delivered = await deliverTeamRecord(record.markdown);
      if (delivered === 'filled') showToast(`팀 기록 ${record.cardCount}개를 입력창에 채웠어요. 질문을 덧붙여 직접 보내세요`, 'ok');
      else if (delivered === 'copied') showToast('입력창에 바로 넣지 못해 클립보드에 복사했어요. 입력창에 붙여넣어 주세요', 'ok');
      else showToast('입력창에도 클립보드에도 넣지 못했어요. 브라우저 권한을 확인해 주세요', 'error');
    } finally {
      recordButton.disabled = false;
    }
  });
}
