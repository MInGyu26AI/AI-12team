import type { TabToast } from './messages';

// AI 채팅 화면 오른쪽 아래의 "싱크업에 보내기"·"선택한 내용 보내기" 버튼과 안내. shadow DOM 으로 사이트 스타일과 분리한다.
const TEMPLATE = `
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

export interface ChatOverlay {
  host: HTMLElement; // 페이지에 붙일 뿌리 요소. 이 안의 화면 변화는 자동 수집이 무시한다
  sendAllButton: HTMLButtonElement;
  sendSelectionButton: HTMLButtonElement;
  showToast(text: string, tone: TabToast['tone']): void;
}

export function createChatOverlay(): ChatOverlay {
  const host = document.createElement('div');
  host.id = 'syncup-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;
  const toast = shadow.querySelector<HTMLDivElement>('.toast')!;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    host,
    sendAllButton: shadow.querySelector<HTMLButtonElement>('button.all')!,
    sendSelectionButton: shadow.querySelector<HTMLButtonElement>('button.sel')!,
    showToast(text, tone) {
      toast.textContent = text;
      toast.className = `toast show ${tone}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.className = 'toast'), tone === 'error' ? 6000 : 3000);
    },
  };
}
