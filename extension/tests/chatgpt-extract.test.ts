// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// ChatGPT 화면 감지 규칙(lib/sites/chatgpt.ts)을 고정 DOM 으로 묶어 둔다. 화면 구조마다 결과(메시지·순서·id·화자·제목·
// 시도한 셀렉터)가 달라지면 이 시험이 깨진다. '2026-11 ChatGPT' 는 실제 탭에서 뽑은 DOM 뼈대를 줄인 것이다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectedMessage } from '@shared/collector';
import { chatgpt } from '@/lib/sites/chatgpt';

const NOW = '2026-11-10T03:00:00.000Z';
const STRATEGY_NAMES = ['author-role', 'turn-attr', 'conversation-turn', 'message-id', 'search-unit', 'article', 'content-blocks', 'repeated-blocks'];

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
    tried: [0, 0, 0, 0, 0, 0, 2],
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
    tried: [0, 0, 0, 0, 0, 0, 0, 4],
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
    tried: [0, 0, 0, 0, 0, 0, 0, 0],
    guessedRoles: 0,
    messages: [],
  },
  {
    name: '로그인 만료 안내만 있는 화면: 안내 문구는 사용자 발화가 아니어서 빈 결과',
    path: '/',
    title: 'ChatGPT',
    html: '<main><article><div>채팅에 액세스하려면 다시 로그인해야 합니다</div></article></main>',
    conversation: { id: 'new', title: 'ChatGPT' },
    selector: null,
    tried: [0, 0, 0, 0, 0, 0, 0, 0],
    guessedRoles: 0,
    messages: [],
  },
  {
    name: '알림 영역(role="alert") 안의 글은 빼고 대화만 읽는다',
    path: '/c/alert1',
    title: '발표 준비 - ChatGPT',
    html: `
      <main>
        <div class="whitespace-pre-wrap">발표 순서 정하자</div>
        <div class="markdown"><p>좋아요</p></div>
        <div role="alert"><div class="whitespace-pre-wrap">네트워크 연결이 끊겼어요. 다시 시도해 주세요</div></div>
      </main>`,
    conversation: { id: 'alert1', title: '발표 준비' },
    selector: 'content-blocks',
    tried: [0, 0, 0, 0, 0, 0, 2],
    guessedRoles: 1,
    messages: [
      { id: 'chatgpt:alert1:14ibvte', role: 'user', text: '발표 순서 정하자', roleGuessed: true },
      { id: 'chatgpt:alert1:45furs', role: 'assistant', text: '좋아요' },
    ],
  },
  {
    name: '안내 문구가 섞인 사용자 글은 그대로 읽는다 (글 전체가 안내 문구일 때만 뺀다)',
    path: '/c/keep1',
    title: '로그인 문제 - ChatGPT',
    html: `
      <main>
        <div data-message-author-role="user" data-message-id="u-7"><div class="whitespace-pre-wrap">채팅에 액세스하려면 다시 로그인해야 합니다 라는 알림이 떠요</div></div>
      </main>`,
    conversation: { id: 'keep1', title: '로그인 문제' },
    selector: 'author-role',
    tried: [1],
    guessedRoles: 0,
    messages: [{ id: 'chatgpt:u-7', role: 'user', text: '채팅에 액세스하려면 다시 로그인해야 합니다 라는 알림이 떠요' }],
  },
  {
    name: '2026-11 ChatGPT: data-chatgpt-search-unit-key 의 화자와 실제 메시지 id, 위젯까지 답변 하나로',
    path: '/c/6af577cc-fd28',
    title: '해커톤 MVP 범위 정리 - ChatGPT',
    html: `
      <main>
        <div class="group flex flex-col" data-talvt-turn-state="complete">
          <div data-chatgpt-search-unit-key="fallback-turn-2:0:user" data-chatgpt-search-message-ids="69278da2-a1c8-450d-b948-afe9adec8149">
            <div class="w-full" data-content-search-unit-key="fallback-turn-2:0:user">
              <div data-user-message-bubble="true"><div class="text-size-chat whitespace-pre-wrap">할 일로 정리해줘</div></div>
            </div>
          </div>
        </div>
        <div class="group flex flex-col">
          <div data-chatgpt-search-unit-key="fallback-turn-2:2:assistant" data-chatgpt-search-message-ids="7acdcd84-d08d-4639-bf08-71b9a647f260 7acdcd84-d08d-4639-bf08-71b9a647f260">
            <h6 class="sr-only">ChatGPT 답변:</h6>
            <div data-markdown-text-style="assistant-message" class="MarkdownRoot-rZKhxa">
              <div class="my-4" data-chatgpt-copy-reference="0"><div class="[--entity-prose-inset:0px]"><div data-dil-response="" data-dil-message-id="7acdcd84-d08d-4639-bf08-71b9a647f260"><h2>해커톤 MVP 할 일 목록</h2><div data-d-component="badge">김민규</div></div></div></div><div class="my-4" data-chatgpt-copy-reference="1"><div class="[--entity-prose-inset:0px]"><p>두 작업 모두 16일 이전 완료 목표야.</p></div></div>
            </div>
          </div>
        </div>
      </main>`,
    conversation: { id: '6af577cc-fd28', title: '해커톤 MVP 범위 정리' },
    selector: 'search-unit',
    tried: [0, 0, 0, 0, 2],
    guessedRoles: 0,
    messages: [
      { id: 'chatgpt:69278da2-a1c8-450d-b948-afe9adec8149', role: 'user', text: '할 일로 정리해줘' },
      { id: 'chatgpt:7acdcd84-d08d-4639-bf08-71b9a647f260', role: 'assistant', text: '해커톤 MVP 할 일 목록\n김민규\n두 작업 모두 16일 이전 완료 목표야.' },
    ],
  },
  {
    // 리허설 실측(11/13): 다른 대화로 옮겨도 앞 대화의 메시지 요소가 페이지에 남고, 조상에 display:none 이 걸려 있다. 읽으면 앞 대화가 지금 대화 id 로 다시 수집된다
    name: '2026-11 ChatGPT: 앞 대화 메시지가 조상 display:none 아래 남아 있으면 읽지 않고 지금 보이는 대화만 읽는다',
    path: '/c/now-conv',
    title: '지금 대화 - ChatGPT',
    html: `
      <nav><a aria-current="page" href="/c/now-conv">지금 대화</a></nav>
      <main>
        <div class="relative h-full min-h-0" style="display: none">
          <div class="group flex flex-col"><div class="flex"><div class="stale-wrapper">
            <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="stale-user-1">
              <h5 class="sr-only">나의 말:</h5><div class="whitespace-pre-wrap">앞 대화 질문</div>
            </div>
            <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="stale-assistant-1 stale-assistant-1">
              <h6 class="sr-only">ChatGPT 답변:</h6><div data-markdown-text-style="assistant-message">앞 대화 답변</div>
            </div>
          </div></div></div>
        </div>
        <div class="relative h-full min-h-0">
          <div class="group flex flex-col">
            <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="now-user-1">
              <h5 class="sr-only">나의 말:</h5><div class="whitespace-pre-wrap">지금 대화 질문</div>
            </div>
            <div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="now-assistant-1 now-assistant-1">
              <h6 class="sr-only">ChatGPT 답변:</h6><div data-markdown-text-style="assistant-message">지금 대화 답변</div>
            </div>
          </div>
        </div>
      </main>`,
    conversation: { id: 'now-conv', title: '지금 대화' },
    selector: 'search-unit',
    tried: [0, 0, 0, 0, 2], // 보이는 것만 센다
    guessedRoles: 0,
    messages: [
      { id: 'chatgpt:now-user-1', role: 'user', text: '지금 대화 질문' },
      { id: 'chatgpt:now-assistant-1', role: 'assistant', text: '지금 대화 답변' },
    ],
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

// ── 보이지 않는 메시지 요소 (약속 8-1 R1) ──
describe('보이지 않는 메시지 요소는 모든 추출 전략에서 뺀다', () => {
  const STALE = '앞 대화';
  const NOW_TEXT = ['지금 질문', '지금 답변'];
  const textsOf = () => chatgpt.extract().messages.map((m) => m.text);
  const setBody = (html: string) => {
    history.replaceState(null, '', '/c/now-conv');
    document.title = 'ChatGPT';
    document.body.innerHTML = html;
  };

  // 전략마다: 앞 대화(숨김)와 지금 대화(보임)를 같이 둔다
  const VARIANTS: [string, string, (hide: string) => string][] = [
    [
      'author-role',
      'author-role',
      (hide) => `<main>
        <div ${hide}><div data-message-author-role="user"><div class="whitespace-pre-wrap">${STALE} 질문</div></div><div data-message-author-role="assistant"><div class="markdown">${STALE} 답변</div></div></div>
        <div data-message-author-role="user"><div class="whitespace-pre-wrap">지금 질문</div></div><div data-message-author-role="assistant"><div class="markdown">지금 답변</div></div></main>`,
    ],
    [
      'turn-attr',
      'turn-attr',
      (hide) => `<main>
        <section ${hide}><article data-turn="user"><div>${STALE} 질문</div></article><article data-turn="assistant"><div class="markdown">${STALE} 답변</div></article></section>
        <article data-turn="user"><div>지금 질문</div></article><article data-turn="assistant"><div class="markdown">지금 답변</div></article></main>`,
    ],
    [
      'conversation-turn',
      'conversation-turn',
      (hide) => `<main>
        <div ${hide}><div data-testid="conversation-turn-1"><div>${STALE} 질문</div></div><div data-testid="conversation-turn-2"><div class="markdown">${STALE} 답변</div></div></div>
        <div data-testid="conversation-turn-3"><div>지금 질문</div></div><div data-testid="conversation-turn-4"><div class="markdown">지금 답변</div></div></main>`,
    ],
    [
      'message-id',
      'message-id',
      (hide) => `<main>
        <div ${hide}><div data-message-id="old-1"><div>${STALE} 질문</div></div><div data-message-id="old-2"><div class="markdown">${STALE} 답변</div></div></div>
        <div data-message-id="new-1"><div>지금 질문</div></div><div data-message-id="new-2"><div class="markdown">지금 답변</div></div></main>`,
    ],
    [
      'article',
      'article',
      (hide) => `<main>
        <div ${hide}><article><div>${STALE} 질문</div></article><article><div class="markdown">${STALE} 답변</div></article></div>
        <article><div>지금 질문</div></article><article><div class="markdown">지금 답변</div></article></main>`,
    ],
    [
      'content-blocks',
      'content-blocks',
      (hide) => `<main>
        <div ${hide}><div class="whitespace-pre-wrap">${STALE} 질문</div><div class="markdown">${STALE} 답변</div></div>
        <div><div class="whitespace-pre-wrap">지금 질문</div><div class="markdown">지금 답변</div></div></main>`,
    ],
    [
      'repeated-blocks',
      'repeated-blocks',
      (hide) => `<main><div>
        <p ${hide}>${STALE} 질문</p><p ${hide}>${STALE} 답변</p><p ${hide}>${STALE} 질문 2</p><p ${hide}>${STALE} 답변 2</p>
        <p>지금 질문</p><p>지금 답변</p><p>지금 질문 2</p><p>지금 답변 2</p></div></main>`,
    ],
  ];

  describe.each([
    ['인라인 display:none', 'style="display: none"'],
    ['hidden 속성', 'hidden'],
  ])('조상에 %s', (_label, hide) => {
    it.each(VARIANTS.map(([name, selector, html]) => [name, selector, html] as const))('%s 전략', (name, selector, html) => {
      setBody(html(hide));
      const result = chatgpt.extract();
      expect(result.selector).toBe(selector);
      expect(result.messages.map((m) => m.text).every((t) => !t.includes(STALE))).toBe(true);
      // repeated-blocks 는 보이는 블록 4개, 나머지는 지금 질문·답변 둘
      expect(result.messages.map((m) => m.text)).toEqual(name === 'repeated-blocks' ? ['지금 질문', '지금 답변', '지금 질문 2', '지금 답변 2'] : NOW_TEXT);
    });
  });

  it('숨김 요소가 하나도 없으면 전과 같이 모두 읽는다 (숨김 판정이 보이는 요소를 빼지 않는다)', () => {
    setBody(VARIANTS[0]![2]('')); // hide 속성이 빈 문자열이라 숨김이 아님
    expect(textsOf()).toEqual([`${STALE} 질문`, `${STALE} 답변`, ...NOW_TEXT]);
  });

  it('메시지 요소 자신에 display:none 이 걸려도 뺀다', () => {
    setBody(`<main>
      <div data-message-author-role="user" style="display:none"><div class="whitespace-pre-wrap">${STALE} 질문</div></div>
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">지금 질문</div></div>
      <div data-message-author-role="assistant"><div class="markdown">지금 답변</div></div></main>`);
    expect(textsOf()).toEqual(NOW_TEXT);
  });

  it('안쪽 깊이 숨김이 걸린 조상(22단계 위)도 찾는다', () => {
    const deep = `${'<div>'.repeat(22)}<div data-message-author-role="user"><div class="whitespace-pre-wrap">${STALE} 질문</div></div>${'</div>'.repeat(22)}`;
    setBody(`<main><div class="relative h-full min-h-0" style="display: none">${deep}</div>
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">지금 질문</div></div>
      <div data-message-author-role="assistant"><div class="markdown">지금 답변</div></div></main>`);
    expect(textsOf()).toEqual(NOW_TEXT);
  });

  // 판정 경로: checkVisibility 가 true 를 주면 보이는 것, 없거나 false 면 조상을 직접 본다
  describe('판정 경로', () => {
    const HTML = `<main>
      <div style="display: none"><div data-message-author-role="user"><div class="whitespace-pre-wrap">${STALE} 질문</div></div></div>
      <div style="display: contents"><div data-message-author-role="user" style="display: contents"><div class="whitespace-pre-wrap">지금 질문</div></div></div>
      <div data-message-author-role="assistant"><div class="markdown">지금 답변</div></div></main>`;
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'checkVisibility');
    afterEach(() => {
      if (original) Object.defineProperty(Element.prototype, 'checkVisibility', original);
    });
    const stubCheckVisibility = (value: unknown) => Object.defineProperty(Element.prototype, 'checkVisibility', { value, configurable: true, writable: true });

    it('checkVisibility 가 없으면(jsdom 등) 조상의 display:none·hidden 으로 판단한다', () => {
      stubCheckVisibility(undefined);
      setBody(HTML);
      expect(textsOf()).toEqual(NOW_TEXT);
    });

    it('checkVisibility 가 display: contents 요소에 false 를 줘도 조상에 display:none 이 없으면 읽는다 (Chrome 동작)', () => {
      // Chrome 처럼: 자신이 display: contents 이거나 조상 중 display:none 이 있으면 false
      stubCheckVisibility(function (this: Element) {
        if (getComputedStyle(this).display === 'contents') return false;
        for (let n: Element | null = this; n; n = n.parentElement) if (getComputedStyle(n).display === 'none') return false;
        return true;
      });
      setBody(HTML);
      expect(textsOf()).toEqual(NOW_TEXT);
    });

    it('checkVisibility 가 true 를 주는 요소는 조상을 더 보지 않고 읽는다', () => {
      const check = vi.fn(() => true);
      stubCheckVisibility(check);
      setBody(`<main><div data-message-author-role="user"><div class="whitespace-pre-wrap">보이는 질문</div></div><div data-message-author-role="assistant"><div class="markdown">보이는 답변</div></div></main>`);
      expect(textsOf()).toEqual(['보이는 질문', '보이는 답변']);
      expect(check).toHaveBeenCalled();
    });
  });
});
