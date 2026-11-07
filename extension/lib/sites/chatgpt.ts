// ChatGPT 화면 전용 추출. ChatGPT DOM 이 바뀌면 이 파일(특히 SELECTORS)만 고친다.
import type { CollectedMessage } from '@shared/collector';
import type { SiteAdapter } from './types';

const SELECTORS = {
  // 위에서부터 시도, 처음으로 메시지가 나오는 셀렉터를 쓴다
  message: [
    '[data-message-author-role]',
    'article [data-message-author-role]',
    '[data-testid^="conversation-turn-"]', // 대체: 대화 턴 단위
  ],
  // 메시지 안의 본문 (없으면 요소 전체 텍스트)
  body: ['.markdown', '.whitespace-pre-wrap', '[data-message-content]'],
  // 답변 생성 중에만 보이는 정지 버튼
  streaming: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="중지"]'],
  title: ['nav a[aria-current="page"]', 'nav [data-active] a', 'title'],
} as const;

const first = (root: ParentNode, selectors: readonly string[]) => {
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
};

function roleOf(el: HTMLElement): CollectedMessage['role'] | null {
  const attr = el.dataset.messageAuthorRole ?? el.querySelector<HTMLElement>('[data-message-author-role]')?.dataset.messageAuthorRole;
  if (attr === 'user') return 'user';
  if (attr === 'assistant') return 'assistant';
  // 대체 셀렉터일 때: 스크린리더용 머리말 "You said:" / "ChatGPT said:"
  const heading = el.querySelector('h5, h6')?.textContent ?? '';
  if (/you said|나의 말/i.test(heading)) return 'user';
  if (/chatgpt said|chatgpt의 말/i.test(heading)) return 'assistant';
  return null;
}

// 간단한 문자열 해시 (메시지 id 가 없을 때 중복 판별용)
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const conversationId = () => location.pathname.match(/\/c\/([\w-]+)/)?.[1] ?? 'new';

function conversationTitle() {
  const el = first(document, SELECTORS.title);
  const text = (el?.tagName === 'TITLE' ? document.title : el?.textContent)?.trim() ?? '';
  return text.replace(/\s*[-|]\s*ChatGPT$/, '') || '(제목 없음)';
}

export const chatgpt: SiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],

  isConversationPage: () => /\/c\/[\w-]+/.test(location.pathname),

  extract() {
    for (const selector of SELECTORS.message) {
      const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
      if (!nodes.length) continue;

      const streaming = !!first(document, SELECTORS.streaming);
      const convId = conversationId();
      const title = conversationTitle();
      const now = new Date().toISOString();

      const messages: CollectedMessage[] = [];
      nodes.forEach((el, i) => {
        const role = roleOf(el);
        if (!role) return;
        // 생성 중인 마지막 AI 답변은 완료된 뒤에 다시 읽는다
        if (streaming && role === 'assistant' && i === nodes.length - 1) return;
        const text = (first(el, SELECTORS.body) ?? el).innerText.trim();
        if (!text) return;
        const siteId = el.dataset.messageId ?? el.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId;
        messages.push({
          id: `chatgpt:${siteId ?? `${convId}:${role}:${hash(text)}`}`,
          site: 'chatgpt',
          role,
          text,
          conversationId: convId,
          conversationTitle: title,
          url: location.href,
          collectedAt: now,
        });
      });
      if (messages.length) return { messages, selector };
    }
    return { messages: [], selector: null };
  },
};
