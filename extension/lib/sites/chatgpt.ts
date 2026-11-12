// ChatGPT 화면 전용 추출. ChatGPT DOM 이 바뀌면 이 파일 맨 위 SELECTORS 만 고친다.
// 진단: ChatGPT 탭 콘솔에서 "[싱크업]" 로그를 보면 어떤 셀렉터가 먹혔는지 나온다.
// 더 자세히 보려면 scripts/chatgpt-diagnose.js 를 그 탭 콘솔에 붙여넣는다 (결과에 대화 앞부분이 나오니 공유 전에 가린다).
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
    // 2026-11 ChatGPT: 메시지마다 data-chatgpt-search-unit-key="…:user" / "…:assistant" 와 data-chatgpt-search-message-ids 가 붙는다
    { name: 'search-unit', selector: '[data-chatgpt-search-unit-key]' },
    { name: 'article', selector: 'main article' },
    { name: 'content-blocks', selector: 'main .whitespace-pre-wrap, main .markdown, main [class*="prose"]' },
    // 마지막 수단: main 안에서 같은 태그가 가장 많이 반복되는 블록들 (repeatedBlocks 함수)
  ],
  // 화자를 알려주는 속성 (요소 자신 → 안쪽 → 바깥쪽 순으로 찾음)
  // data-chatgpt-search-unit-key 는 "fallback-turn-2:0:user" 처럼 화자가 맨 뒤에 붙는다
  roleAttrs: ['data-message-author-role', 'data-turn', 'data-role', 'data-author', 'data-chatgpt-search-unit-key'],
  // 메시지 안의 본문 (없으면 요소 전체 텍스트)
  // [data-markdown-text-style]: 2026-11 AI 답변 루트. 블록·위젯(할 일 목록 등)이 모두 이 안에 있다
  body: ['[data-markdown-text-style]', '.markdown', '.whitespace-pre-wrap', '[data-message-content]', '[class*="prose"]'],
  // AI 답변 본문에만 쓰이는 표시 (화자 추정용)
  assistantHint: '[data-markdown-text-style="assistant-message"], .markdown, [class*="prose"]',
  // 답변 생성 중에만 보이는 정지 버튼
  streaming: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="중지"]'],
  // 사이트 메시지 id 를 담는 속성 (요소 자신 → 안쪽 순). data-chatgpt-search-message-ids 는 공백으로 나뉜 id 목록이라 첫 id 를 쓴다
  messageIdAttrs: ['data-message-id', 'data-chatgpt-search-message-ids'],
  title: ['nav a[aria-current="page"]', 'nav [data-active] a'],
  // 대화가 아닌 알림 영역. 이 안의 요소는 메시지로 읽지 않는다
  notice: '[role="alert"], [role="alertdialog"]',
} as const;

// 알림 영역 표시 없이 그려지는 ChatGPT 안내 문구. 글 전체가 이 문구일 때만 뺀다 (같은 말이 섞인 사용자 글은 남긴다)
const NOTICE_TEXT = /^채팅에 액세스하려면 다시 로그인해야 합니다\.?$/;

// 스크린리더용 머리말 ("You said:" 등) — 화자 추정 + 본문에서 제거
const USER_HEADING = /^(you said|나의 말|내가 말함|내가 한 말)\s*:?\s*$/i;
const AI_HEADING = /^(chatgpt said|chatgpt의 말|chatgpt가 말함|chatgpt 답변)\s*:?\s*$/i;
const CONVERSATION_PATH = /\/c\/([\w-]+)/;

type Role = CollectedMessage['role'];

const first = (root: ParentNode, selectors: readonly string[]) => {
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
};

const toRole = (v: string | null | undefined): Role | null => {
  const s = v?.toLowerCase().split(':').pop(); // "fallback-turn-2:0:user" → "user"
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
    // textContent: innerText 와 달리 레이아웃 계산이 없어 빠르다
    const kids = [...parent.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.textContent?.trim());
    if (kids.length < 4) return;
    const byTag = new Map<string, HTMLElement[]>();
    kids.forEach((k) => byTag.set(k.tagName, [...(byTag.get(k.tagName) ?? []), k]));
    for (const group of byTag.values()) if (group.length > best.length) best = group;
  });
  return best;
}

// 전략은 차례로 하나씩 계산한다. 앞 전략이 메시지를 찾으면 뒤 전략(특히 repeatedBlocks)은 계산하지 않는다
const STRATEGIES: { name: string; nodes: () => HTMLElement[] }[] = [
  ...SELECTORS.strategies.map((s) => ({
    name: s.name,
    nodes: () => outermost([...document.querySelectorAll<HTMLElement>(s.selector)]),
  })),
  { name: 'repeated-blocks', nodes: repeatedBlocks },
];

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

const conversationIdOf = (url: string) => new URL(url).pathname.match(CONVERSATION_PATH)?.[1] ?? 'new';
const titleOf = (title: string) => title.replace(/\s*[-|]\s*ChatGPT$/, '').trim() || '(제목 없음)';
const conversationTitle = () => titleOf(first(document, SELECTORS.title)?.textContent?.trim() || document.title);

const siteIdOf = (el: HTMLElement) => {
  for (const attr of SELECTORS.messageIdAttrs) {
    const value = el.getAttribute(attr) ?? el.querySelector(`[${attr}]`)?.getAttribute(attr);
    const id = value?.trim().split(/\s+/)[0];
    if (id) return id;
  }
  return undefined;
};

// 글이 있는 요소들 → 수집 메시지. 생성 중인 마지막 AI 답변은 완료된 뒤에 다시 읽는다
function toMessages(found: { el: HTMLElement; text: string }[]) {
  const { roles, guessed } = fillRoles(found.map((x) => roleOf(x.el)));
  const streaming = !!first(document, SELECTORS.streaming);
  const convId = conversationIdOf(location.href);
  const title = conversationTitle();
  const now = new Date().toISOString();
  const messages: CollectedMessage[] = [];
  found.forEach(({ el, text }, i) => {
    if (streaming && i === found.length - 1 && roles[i] === 'assistant') return;
    const siteId = siteIdOf(el);
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
  return { messages, guessedRoles: guessed.filter(Boolean).length };
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

  isConversationPage: () => CONVERSATION_PATH.test(location.pathname),
  conversationIdOf,
  titleOf,

  extract(): ExtractResult {
    const tried: ExtractResult['tried'] = [];
    for (const { name, nodes } of STRATEGIES) {
      const found = nodes()
        .filter((el) => !el.closest(SELECTORS.notice))
        .map((el) => ({ el, text: textOf(el) }))
        .filter((x) => x.text.length > 0 && !NOTICE_TEXT.test(x.text));
      tried.push({ name, count: found.length });
      if (!found.length) continue;

      const { messages, guessedRoles } = toMessages(found);
      // 대화마다, 그리고 먹힌 전략이 바뀔 때만 찍는다 (새 메시지마다 찍지 않음)
      logOnce(`ok:${location.pathname}:${name}`, () =>
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
