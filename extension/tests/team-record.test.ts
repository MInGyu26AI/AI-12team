// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// 팀 기록 불러오기: 팀 보드 → 마크다운(웹의 "팀 기록 복사"와 같은 글), ChatGPT 입력창 찾기·채우기, 못 채울 때의 클립보드 대체.
// 실제 chatgpt.com 에는 요청하지 않고, 입력창은 ProseMirror 흉내로 만든 가짜 화면으로 시험한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardToMarkdown } from '@shared/board-markdown';
import type { Conflict, RelatedCard } from '@shared/types';
import { EMPTY_RECORD_GUIDE, copyText, deliverTeamRecord, fillComposer, findComposer, loadTeamRecord } from '@/lib/team-record';

const card = (patch: Partial<RelatedCard>): RelatedCard => ({
  relevance: 'related', status: 'approved', source: 'ChatGPT, 2026-11-06 21:10', masked: false, confidence: 0.9, is_new_topic: false,
  reason: null, due: null, is_change: false, id: 'c', sentence: 'x', subtopic: '작업·결과물', tag: 'decision', topic_key: 'MVP 범위',
  content: '브라우저 확장 = MVP 포함', owner: '이서준', ...patch,
});
const cards = [
  card({ id: 'd1' }),
  card({ id: 't1', tag: 'todo', topic_key: '배포', content: 'Vercel 배포', owner: '김단비', due: '2026-11-15' }),
  card({ id: 'r1', tag: 'research', subtopic: '자료 조사', topic_key: '경쟁 서비스', content: 'Notion AI는 팀 메모리가 없음', owner: null }),
];
const conflicts: Conflict[] = [
  { id: 'x1', topic_key: 'MVP 범위', cardA: cards[0]!, cardB: card({ id: 'd9', content: '브라우저 확장은 MVP 제외' }), judgement: '충돌', reason: 'r' },
];

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 12, 0, 0)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as { execCommand?: unknown }).execCommand;
});

// ChatGPT 입력창 흉내: contenteditable 이고, 붙여넣기를 받으면 ProseMirror 처럼 기본 동작을 막고 줄마다 문단으로 넣는다
function mountEditor({ draft = '', handlesPaste = true } = {}) {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true">${draft ? `<p>${draft}</p>` : '<p><br></p>'}</div></form>`,
  );
  const el = document.querySelector<HTMLElement>('#prompt-textarea')!;
  const pasted: string[] = [];
  el.addEventListener('paste', (event) => {
    pasted.push((event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '');
    if (!handlesPaste) return;
    event.preventDefault();
    if (!el.textContent?.trim()) el.replaceChildren();
    for (const line of pasted.at(-1)!.split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      el.append(p);
    }
  });
  return { el, pasted };
}
const lines = (el: HTMLElement) => [...el.querySelectorAll('p')].map((p) => p.textContent);

describe('팀 기록 만들기 (loadTeamRecord)', () => {
  it('웹의 "팀 기록 복사"와 같은 글을 만든다', async () => {
    const result = await loadTeamRecord(async () => ({ cards, conflicts }));
    expect(result).toEqual({ ok: true, markdown: boardToMarkdown(cards, conflicts), cardCount: 3 });
    expect(result.ok && result.markdown).toContain('- [결정] MVP 범위: 브라우저 확장 = MVP 포함 (결정 이서준)');
    expect(result.ok && result.markdown).toContain('## 아직 정리되지 않은 충돌');
  });

  it('카드가 없으면 보내지 않고 안내한다 (웹도 카드가 없으면 복사 버튼을 막는다)', async () => {
    expect(await loadTeamRecord(async () => ({ cards: [], conflicts }))).toEqual({ ok: false, error: EMPTY_RECORD_GUIDE });
  });

  it('받아 오다 실패하면 그 문구를 돌려준다', async () => {
    expect(await loadTeamRecord(async () => Promise.reject(new Error('로컬 수집기 연결 실패')))).toEqual({ ok: false, error: '로컬 수집기 연결 실패' });
    expect(await loadTeamRecord(async () => Promise.reject('x'))).toEqual({ ok: false, error: '팀 기록을 불러오지 못했어요' });
  });

  it('형식이 어긋난 응답은 오류로 본다', async () => {
    expect(await loadTeamRecord((async () => ({})) as never)).toEqual({ ok: false, error: '팀 기록을 불러오지 못했어요' });
  });

  it('충돌 목록이 빠져 있어도 카드는 만든다', async () => {
    const result = await loadTeamRecord((async () => ({ cards })) as never);
    expect(result.ok && result.markdown).toBe(boardToMarkdown(cards, []));
  });
});

describe('입력창 찾기 (findComposer)', () => {
  it('ProseMirror 입력창(#prompt-textarea)을 찾는다', () => {
    const { el } = mountEditor();
    expect(findComposer()).toBe(el);
  });

  it('숨겨진 textarea 보다 보이는 ProseMirror 입력창을 먼저 고른다', () => {
    document.body.insertAdjacentHTML('beforeend', '<form><textarea name="prompt-textarea" style="display:none"></textarea></form>');
    const { el } = mountEditor();
    expect(findComposer()).toBe(el);
  });

  it('예전 화면의 textarea 도 찾는다', () => {
    document.body.insertAdjacentHTML('beforeend', '<form><textarea id="prompt-textarea"></textarea></form>');
    expect(findComposer()).toBe(document.querySelector('textarea'));
  });

  it('숨겨졌거나 비활성이면 건너뛰고, 없으면 null', () => {
    document.body.insertAdjacentHTML('beforeend', '<form><textarea id="prompt-textarea" disabled></textarea></form>');
    expect(findComposer()).toBeNull();
    document.body.replaceChildren();
    document.body.insertAdjacentHTML('beforeend', '<div hidden><div id="prompt-textarea" contenteditable="true"></div></div>');
    expect(findComposer()).toBeNull();
    document.body.replaceChildren();
    expect(findComposer()).toBeNull();
  });

  it('싱크업 안내 영역 안의 입력칸은 입력창으로 보지 않는다', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="syncup-root"><textarea id="prompt-textarea"></textarea></div>');
    expect(findComposer()).toBeNull();
  });
});

describe('입력창 채우기 (fillComposer)', () => {
  it('붙여넣기로 줄마다 문단을 만들어 넣고 true', () => {
    const { el, pasted } = mountEditor();
    const text = '# 싱크업 팀 기록\n\n## 기타\n- [결정] 팀 이름은 싱크업';
    expect(fillComposer(text)).toBe(true);
    expect(pasted).toEqual([text]);
    expect(lines(el)).toEqual(['# 싱크업 팀 기록', '', '## 기타', '- [결정] 팀 이름은 싱크업']);
  });

  it('쓰던 글은 지우지 않고 빈 줄을 두고 뒤에 잇는다', () => {
    const { el, pasted } = mountEditor({ draft: '이 기록 보고 일정을 짜줘' });
    expect(fillComposer('# 팀 기록\n- [결정] A')).toBe(true);
    expect(pasted).toEqual(['\n\n# 팀 기록\n- [결정] A']);
    expect(lines(el)).toEqual(['이 기록 보고 일정을 짜줘', '', '', '# 팀 기록', '- [결정] A']);
  });

  it('붙여넣기를 편집기가 처리하지 않으면 입력 명령(insertText)으로 넣는다', () => {
    const { el } = mountEditor({ handlesPaste: false });
    const execCommand = vi.fn((_command: string, _ui: boolean, value?: string) => {
      el.textContent = value ?? '';
      return true;
    });
    document.execCommand = execCommand;
    expect(fillComposer('# 팀 기록\n- [결정] A')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '# 팀 기록\n- [결정] A');
  });

  it('붙여넣기가 이미 들어갔으면 입력 명령은 부르지 않는다 (두 번 들어가지 않게)', () => {
    mountEditor();
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    expect(fillComposer('# 팀 기록\n- [결정] A')).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('붙여넣기도 입력 명령도 글을 못 넣으면 false', () => {
    const { el } = mountEditor({ handlesPaste: false });
    document.execCommand = vi.fn(() => true); // 성공이라고 답하지만 입력창은 그대로
    expect(fillComposer('# 팀 기록\n- [결정] A')).toBe(false);
    expect(el.textContent).toBe('');
    document.execCommand = vi.fn(() => false);
    expect(fillComposer('# 팀 기록\n- [결정] A')).toBe(false);
  });

  it('입력창이 없으면 false', () => {
    expect(fillComposer('# 팀 기록')).toBe(false);
  });

  it('textarea 는 값을 넣고 input 이벤트를 보낸다. 쓰던 글은 뒤에 잇는다', () => {
    document.body.insertAdjacentHTML('beforeend', '<form><textarea id="prompt-textarea">먼저 쓴 글  </textarea></form>');
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const onInput = vi.fn();
    textarea.addEventListener('input', onInput);
    expect(fillComposer('# 팀 기록')).toBe(true);
    expect(textarea.value).toBe('먼저 쓴 글\n\n# 팀 기록');
    expect(onInput).toHaveBeenCalledTimes(1);
  });
});

describe('입력창에 못 넣을 때의 대체 (deliverTeamRecord)', () => {
  const stubClipboard = (writeText: (text: string) => Promise<void>) =>
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  it('입력창에 채우면 클립보드는 건드리지 않는다', async () => {
    mountEditor();
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    expect(await deliverTeamRecord('# 팀 기록')).toBe('filled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('입력창을 못 찾으면 클립보드에 복사한다', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    expect(await deliverTeamRecord('# 팀 기록')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('# 팀 기록');
  });

  it('입력창에 넣지 못해도 클립보드로 대신한다', async () => {
    mountEditor({ handlesPaste: false });
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    expect(await deliverTeamRecord('# 팀 기록')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('# 팀 기록');
  });

  it('클립보드도 막히면 failed', async () => {
    stubClipboard(async () => Promise.reject(new Error('denied')));
    expect(await copyText('x')).toBe(false);
    expect(await deliverTeamRecord('# 팀 기록')).toBe('failed');
  });
});
