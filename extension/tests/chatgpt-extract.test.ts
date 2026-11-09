// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// ChatGPT 화면 감지 규칙(lib/sites/chatgpt.ts)을 고정 DOM 으로 묶어 둔다. 감지 규칙은 바꾸지 않기로 한 대상이라
// 결과(메시지·순서·id·화자·제목·시도한 셀렉터)가 달라지면 이 시험이 깨진다. 기대값은 56f49ff 의 추출 코드에서도 같게 나온다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectedMessage } from '@shared/collector';
import { chatgpt } from '@/lib/sites/chatgpt';

const NOW = '2026-11-10T03:00:00.000Z';
const STRATEGY_NAMES = ['author-role', 'turn-attr', 'conversation-turn', 'message-id', 'article', 'content-blocks', 'repeated-blocks'];

interface Fixture {
  name: string;
  path: string;
  title: string;
  html: string;
  conversation: { id: string; title: string };
  selector: string | null;
  tried: number[]; // 앞에서부터 시도한 전략별 찾은 수 (메시지를 찾은 전략에서 멈춘다)
  guessedRoles: number;
  messages: { id: string; role: CollectedMessage['role']; text: string; roleGuessed?: true }[];
}

const FIXTURES: Fixture[] = [
  {
    name: '예전 ChatGPT: data-message-author-role 과 사이트 메시지 id, 왼쪽 목록의 제목',
    path: '/c/abc-123',
    title: 'ChatGPT',
    html: `
      <nav><a href="/c/old">지난 대화</a><a aria-current="page" href="/c/abc-123">MVP 범위 회의</a></nav>
      <main>
        <div data-message-author-role="user" data-message-id="u-1"><div class="whitespace-pre-wrap">브라우저 확장도 MVP에 넣자.</div></div>
        <div data-message-author-role="assistant" data-message-id="a-1"><div class="markdown"><p>좋아요.</p><p>시연 효과가 커요.</p></div></div>
        <div data-message-author-role="user" data-message-id="u-2"><div class="whitespace-pre-wrap">   </div></div>
      </main>`,
    conversation: { id: 'abc-123', title: 'MVP 범위 회의' },
    selector: 'author-role',
    tried: [2],
    guessedRoles: 0,
    messages: [
      { id: 'chatgpt:u-1', role: 'user', text: '브라우저 확장도 MVP에 넣자.' },
      { id: 'chatgpt:a-1', role: 'assistant', text: '좋아요.\n시연 효과가 커요.' },
    ],
  },
  {
    name: '최근 ChatGPT: article[data-turn], 안쪽 메시지 id, 생성 중인 마지막 답변은 뺀다',
    path: '/c/def456',
    title: '일정 정리 - ChatGPT',
    html: `
      <main>
        <article data-turn="user"><h5 class="sr-only">You said:</h5><div data-message-id="u-9"><div class="whitespace-pre-wrap">발표는 11/16이야</div></div></article>
        <article data-turn="assistant"><h6 class="sr-only">ChatGPT said:</h6><div data-message-id="a-9"><div class="markdown">확인했어요</div></div></article>
        <article data-turn="user"><div data-message-id="u-10"><div class="whitespace-pre-wrap">역할도 정하자</div></div></article>
        <article data-turn="assistant"><div data-message-id="a-10"><div class="markdown">생성 중</div></div></article>
      </main>
      <button data-testid="stop-button">Stop</button>`,
    conversation: { id: 'def456', title: '일정 정리' },
    selector: 'turn-attr',
    tried: [0, 4],
    guessedRoles: 0,
    messages: [
      { id: 'chatgpt:u-9', role: 'user', text: '발표는 11/16이야' },
      { id: 'chatgpt:a-9', role: 'assistant', text: '확인했어요' },
      { id: 'chatgpt:u-10', role: 'user', text: '역할도 정하자' },
    ],
  },
  {
    name: '화자 속성 없음: 머리말·답변 표시로 읽고 나머지는 순서로 추정, id 는 대화 id + 본문 해시',
    path: '/c/ghi789',
    title: '',
    html: `
      <main>
        <div data-testid="conversation-turn-1"><h5 class="sr-only">나의 말:</h5><div>MVP는 웹만 하자</div></div>
        <div data-testid="conversation-turn-2"><div>그럼 확장은 빼는 거죠?</div></div>
        <div data-testid="conversation-turn-3"><div>응 빼자</div></div>
        <div data-testid="conversation-turn-4"><div class="markdown">알겠어요</div></div>
      </main>`,
    conversation: { id: 'ghi789', title: '(제목 없음)' },
    selector: 'conversation-turn',
    tried: [0, 0, 4],
    guessedRoles: 2,
    messages: [
      { id: 'chatgpt:ghi789:19bjq6x', role: 'user', text: 'MVP는 웹만 하자' },
      { id: 'chatgpt:ghi789:cvj1ma', role: 'assistant', text: '그럼 확장은 빼는 거죠?', roleGuessed: true },
      { id: 'chatgpt:ghi789:1suyy1u', role: 'user', text: '응 빼자', roleGuessed: true },
      { id: 'chatgpt:ghi789:1tckrll', role: 'assistant', text: '알겠어요' },
    ],
  },
  {
    name: '본문 블록만 있음: 겹친 블록은 가장 바깥 것만, 답변 표시로 화자를 읽고 왼쪽 목록의 활성 항목이 제목',
    path: '/c/jkl',
    title: 'ChatGPT',
    html: `
      <nav><div data-active><a href="/c/jkl">자료 조사</a></div></nav>
      <main>
        <div class="whitespace-pre-wrap">경쟁 서비스 찾아줘</div>
        <div class="prose"><div class="markdown"><p>세 곳이 있어요</p></div></div>
      </main>`,
    conversation: { id: 'jkl', title: '자료 조사' },
    selector: 'content-blocks',
    tried: [0, 0, 0, 0, 0, 2],
    guessedRoles: 1,
    messages: [
      { id: 'chatgpt:jkl:3hdj9d', role: 'user', text: '경쟁 서비스 찾아줘', roleGuessed: true },
      { id: 'chatgpt:jkl:1w6lpn8', role: 'assistant', text: '세 곳이 있어요' },
    ],
  },
  {
    name: '표시가 하나도 없음: 마지막 수단으로 main 안에서 같은 태그가 4개 이상 반복되는 블록',
    path: '/',
    title: '새 채팅 | ChatGPT',
    html: `
      <main>
        <aside><span>메뉴</span><span>설정</span></aside>
        <section><div>첫 질문</div><div>첫 답변</div><div>둘째 질문</div><div>둘째 답변</div><div> </div></section>
      </main>`,
    conversation: { id: 'new', title: '새 채팅' },
    selector: 'repeated-blocks',
    tried: [0, 0, 0, 0, 0, 0, 4],
    guessedRoles: 4,
    messages: [
      { id: 'chatgpt:new:1toc67k', role: 'user', text: '첫 질문', roleGuessed: true },
      { id: 'chatgpt:new:1to81qd', role: 'assistant', text: '첫 답변', roleGuessed: true },
      { id: 'chatgpt:new:f2f0d1', role: 'user', text: '둘째 질문', roleGuessed: true },
      { id: 'chatgpt:new:f2avvu', role: 'assistant', text: '둘째 답변', roleGuessed: true },
    ],
  },
  {
    name: '대화로 볼 블록이 없음: 같은 태그가 3개만 반복되면 마지막 수단도 쓰지 않고 빈 결과',
    path: '/c/empty',
    title: '빈 대화 - ChatGPT',
    html: '<main><div></div><ul><li>새 채팅</li><li>검색</li><li>라이브러리</li></ul></main>',
    conversation: { id: 'empty', title: '빈 대화' },
    selector: null,
    tried: [0, 0, 0, 0, 0, 0, 0],
    guessedRoles: 0,
    messages: [],
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ChatGPT 화면 추출 (고정 DOM)', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    history.replaceState(null, '', f.path);
    document.title = f.title;
    document.body.innerHTML = f.html;

    const result = chatgpt.extract();

    expect(result.selector).toBe(f.selector);
    expect(result.tried).toEqual(f.tried.map((count, i) => ({ name: STRATEGY_NAMES[i], count })));
    expect(result.guessedRoles).toBe(f.guessedRoles);
    expect(result.messages).toStrictEqual(
      f.messages.map(({ id, role, text, roleGuessed }) => ({
        id,
        site: 'chatgpt',
        role,
        ...(roleGuessed ? { roleGuessed } : {}),
        text,
        conversationId: f.conversation.id,
        conversationTitle: f.conversation.title,
        url: `https://chatgpt.com${f.path}`,
        collectedAt: NOW,
      })),
    );
  });
});
