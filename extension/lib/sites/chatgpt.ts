// ChatGPT 화면 전용 추출. ChatGPT DOM 이 바뀌면 이 파일 맨 위 SELECTORS 만 고친다.
// 진단: ChatGPT 탭 콘솔에서 "[싱크업]" 로그를 보면 어떤 셀렉터가 먹혔는지 나온다.
import type { CollectedMessage } from '@shared/collector';
import { hash } from '../hash';
import type { ExtractResult, SiteAdapter } from './types';

// ─────────────────────────────────────────────────────────────
// 셀렉터 모음 (위에서부터 차례로 시도, 처음으로 메시지가 나오는 전략을 쓴다)
// ─────────────────────────────────────────────────────────────
export const SELECTORS = {
  strategies: [
    { name: 'author-role', selector: '[data-message-author-role]' }, // 예전 ChatGPT
    { name: 'turn-attr', selector: 'article[data-turn], [data-turn]' }, // 최근 ChatGPT: <article data-turn="user">
    { name: 'conversation-turn', selector: '[data-testid^="conversation-turn"]' },
    { name: 'message-id', selector: '[data-message-id]' },
    { name: 'article', selector: 'main article' },
    { name: 'content-blocks', selector: 'main .whitespace-pre-wrap, main .markdown, main [class*="prose"]' },
    // 마지막 수단: main 안에서 같은 태그가 가장 많이 반복되는 블록들 (repeatedBlocks 함수)
  ],
  // 화자를 알려주는 속성 (요소 자신 → 안쪽 → 바깥쪽 순으로 찾음)
  roleAttrs: ['data-message-author-role', 'data-turn', 'data-role', 'data-author'],
  // 메시지 안의 본문 (없으면 요소 전체 텍스트)
  body: ['.markdown', '.whitespace-pre-wrap', '[data-message-content]', '[class*="prose"]'],
  // AI 답변 본문에만 쓰이는 표시 (화자 추정용)
  assistantHint: '.markdown, [class*="prose"]',
  // 답변 생성 중에만 보이는 정지 버튼
  streaming: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="중지"]'],
  // 메시지 id
  messageId: '[data-message-id]',
  // 대화 제목
  title: ['nav a[aria-current="page"]', 'nav [data-active] a'],
} as const;

// 스크린리더용 머리말 ("You said:" 등) — 화자 추정 + 본문에서 제거
const USER_HEADING = /^(you said|나의 말|내가 말함)\s*:?\s*$/i;
const AI_HEADING = /^(chatgpt said|chatgpt의 말|chatgpt가 말함)\s*:?\s*$/i;

type Role = CollectedMessage['role'];

const first = (root: ParentNode, selectors: readonly string[]) => {
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
};

const toRole = (v: string | null | undefined): Role | null => {
  const s = v?.toLowerCase();
  if (!s) return null;
  if (s === 'user' || s === 'human') return 'user';
  if (s === 'assistant' || s === 'ai' || s === 'bot' || s === 'model') return 'assistant';
  return null;
};

function roleOf(el: HTMLElement): Role | null {
  for (const attr of SELECTORS.roleAttrs) {
    const v =
      el.getAttribute(attr) ?? el.querySelector(`[${attr}]`)?.getAttribute(attr) ?? el.closest(`[${attr}]`)?.getAttribute(attr);
    const r = toRole(v);
    if (r) return r;
  }
  const heading = el.querySelector('h5, h6, .sr-only')?.textContent?.trim() ?? '';
  if (USER_HEADING.test(heading)) return 'user';
  if (AI_HEADING.test(heading)) return 'assistant';
  if (el.matches(SELECTORS.assistantHint) || el.querySelector(SELECTORS.assistantHint)) return 'assistant';
  return null;
}

function textOf(el: HTMLElement) {
  const body = first(el, SELECTORS.body) ?? el;
  return body.innerText
    .split('\n')
    .filter((line) => !USER_HEADING.test(line.trim()) && !AI_HEADING.test(line.trim()))
    .join('\n')
    .trim();
}

// 다른 후보 안에 들어 있는 요소는 빼고 가장 바깥 것만
const outermost = (nodes: HTMLElement[]) => nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));

// 마지막 수단: main 안에서 같은 태그 자식이 가장 많은(4개 이상) 컨테이너의 자식들
function repeatedBlocks(): HTMLElement[] {
  const main = document.querySelector('main');
  if (!main) return [];
  let best: HTMLElement[] = [];
  main.querySelectorAll<HTMLElement>('*').forEach((parent) => {
    const kids = [...parent.children].filter((c): c is HTMLElement => c instanceof HTMLElement && (c.textContent ?? '').trim().length > 0); // textContent: 레이아웃 계산 없이 빠름
    if (kids.length < 4) return;
    const byTag = new Map<string, HTMLElement[]>();
    kids.forEach((k) => byTag.set(k.tagName, [...(byTag.get(k.tagName) ?? []), k]));
    for (const group of byTag.values()) if (group.length > best.length) best = group;
  });
  return best;
}

// 화자를 못 읽은 메시지는 앞뒤 메시지와 번갈아 있다고 보고 추정
function fillRoles(roles: (Role | null)[]): { roles: Role[]; guessed: boolean[] } {
  const guessed = roles.map((r) => r === null);
  const out = [...roles];
  const firstKnown = out.findIndex((r) => r !== null);
  if (firstKnown === -1) {
    return { roles: out.map((_, i) => (i % 2 === 0 ? 'user' : 'assistant')), guessed };
  }
  for (let i = firstKnown - 1; i >= 0; i--) out[i] = out[i + 1] === 'user' ? 'assistant' : 'user';
  for (let i = firstKnown + 1; i < out.length; i++) if (out[i] === null) out[i] = out[i - 1] === 'user' ? 'assistant' : 'user';
  return { roles: out as Role[], guessed };
}

const conversationId = () => location.pathname.match(/\/c\/([\w-]+)/)?.[1] ?? 'new';

function conversationTitle() {
  const text = first(document, SELECTORS.title)?.textContent?.trim() || document.title;
  return text.replace(/\s*[-|]\s*ChatGPT$/, '').trim() || '(제목 없음)';
}

// 같은 결과를 디바운스마다 반복해서 찍지 않도록 직전 로그를 기억
let lastLog = '';
function logOnce(key: string, log: () => void) {
  if (key === lastLog) return;
  lastLog = key;
  log();
}

export const chatgpt: SiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],

  isConversationPage: () => /\/c\/[\w-]+/.test(location.pathname),

  extract(): ExtractResult {
    const tried: ExtractResult['tried'] = [];
    const candidates: { name: string; nodes: HTMLElement[] }[] = [
      ...SELECTORS.strategies.map((s) => ({
        name: s.name,
        nodes: outermost([...document.querySelectorAll<HTMLElement>(s.selector)]),
      })),
      { name: 'repeated-blocks', nodes: repeatedBlocks() },
    ];

    for (const { name, nodes } of candidates) {
      const withText = nodes.map((el) => ({ el, text: textOf(el) })).filter((x) => x.text.length > 0);
      tried.push({ name, count: withText.length });
      if (!withText.length) continue;

      const { roles, guessed } = fillRoles(withText.map((x) => roleOf(x.el)));
      const streaming = !!first(document, SELECTORS.streaming);
      const convId = conversationId();
      const title = conversationTitle();
      const now = new Date().toISOString();

      const messages: CollectedMessage[] = [];
      withText.forEach(({ el, text }, i) => {
        // 생성 중인 마지막 AI 답변은 완료된 뒤에 다시 읽는다
        if (streaming && i === withText.length - 1 && roles[i] === 'assistant') return;
        const siteId = el.getAttribute('data-message-id') ?? el.querySelector(SELECTORS.messageId)?.getAttribute('data-message-id');
        messages.push({
          id: `chatgpt:${siteId ?? `${convId}:${hash(text)}`}`,
          site: 'chatgpt',
          role: roles[i]!,
          ...(guessed[i] ? { roleGuessed: true } : {}),
          text,
          conversationId: convId,
          conversationTitle: title,
          url: location.href,
          collectedAt: now,
        });
      });

      const guessedRoles = guessed.filter(Boolean).length;
      logOnce(`ok:${name}:${messages.length}`, () =>
        console.info(
          `[싱크업] 대화 읽기 성공: "${name}" 셀렉터, 메시지 ${messages.length}개` +
            (guessedRoles ? ` (화자 ${guessedRoles}개는 순서로 추정)` : ''),
        ),
      );
      return { messages, selector: name, tried, guessedRoles };
    }

    logOnce(`fail:${location.pathname}`, () =>
      console.warn(
        '[싱크업] 대화를 못 읽었어요. 시도한 셀렉터:',
        tried.map((t) => `${t.name}=${t.count}`).join(', '),
        '→ lib/sites/chatgpt.ts 의 SELECTORS 를 고쳐 주세요',
      ),
    );
    return { messages: [], selector: null, tried, guessedRoles: 0 };
  },
};
