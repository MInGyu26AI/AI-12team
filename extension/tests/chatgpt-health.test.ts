// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// 글이 비어 메시지로 세지 않은 요소 수 (lib/sites/chatgpt-health.ts). chatgpt.ts 의 추출 결과를 그대로 받아 센다
import { beforeEach, describe, expect, it } from 'vitest';
import { assessExtractHealth, summarizeExtract } from '@/lib/extract-health';
import { chatgpt } from '@/lib/sites/chatgpt';
import { countEmptyBodies } from '@/lib/sites/chatgpt-health';

const read = (html: string) => {
  document.body.innerHTML = html;
  const result = chatgpt.extract();
  return { result, empty: countEmptyBodies(result), summary: summarizeExtract(true, result, countEmptyBodies(result)) };
};
const user = (id: string, text: string) => `<div data-message-author-role="user" data-message-id="${id}"><div class="whitespace-pre-wrap">${text}</div></div>`;
const assistant = (id: string, html: string) => `<div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown">${html}</div></div>`;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('countEmptyBodies', () => {
  it('모두 글이 있으면 0', () => {
    const { empty } = read(`<main>${user('u1', '안녕')}${assistant('a1', '<p>네</p>')}</main>`);
    expect(empty).toBe(0);
  });

  it('글이 없는 답변(시각화 위주 답변 등)은 빈 본문으로 센다', () => {
    const { result, empty } = read(`<main>${user('u1', '표로 보여줘')}${assistant('a1', '')}${user('u2', '다시')}${assistant('a2', '<p> </p>')}</main>`);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'user']); // 빈 답변은 메시지로 읽히지 않는다
    expect(empty).toBe(2);
  });

  it('빈 본문이 많으면 구조 점검이 경고한다 (읽은 2개 + 빈 2개 = 50%)', () => {
    const { summary } = read(`<main>${user('u1', '표로 보여줘')}${assistant('a1', '')}${user('u2', '다시')}${assistant('a2', '')}</main>`);
    expect(summary).toMatchObject({ messageCount: 2, emptyBodies: 2 });
    expect(assessExtractHealth(summary).reasons.map((r) => r.code)).toEqual(['many-empty-bodies']);
  });

  it('알림 영역 안의 요소는 세지 않는다', () => {
    const { empty } = read(`<main>${user('u1', '안녕')}<div role="alert"><div data-message-author-role="assistant"></div></div></main>`);
    expect(empty).toBe(0);
  });

  it('다른 후보 안에 든 요소는 세지 않는다 (바깥 것만)', () => {
    const { empty } = read(
      `<main><div data-message-author-role="user" data-message-id="u1"><div data-message-author-role="user"></div><div class="whitespace-pre-wrap">안녕</div></div></main>`,
    );
    expect(empty).toBe(0);
  });

  it('못 읽었거나 셀렉터가 없는 전략(repeated-blocks)이 먹었으면 모른다(undefined)', () => {
    expect(read('<main></main>').empty).toBeUndefined();
    const blocks = Array.from({ length: 5 }, (_, i) => `<section>문단 ${i}</section>`).join('');
    const { result, empty } = read(`<main><div>${blocks}</div></main>`);
    expect(result.selector).toBe('repeated-blocks');
    expect(empty).toBeUndefined();
  });
});
