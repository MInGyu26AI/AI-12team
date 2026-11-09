import { describe, expect, it } from 'vitest';
import { collectResultToast } from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import { chatgpt } from '@/lib/sites/chatgpt';
import { CHAT_PAGE_MATCHES, siteForUrl } from '@/lib/sites';

describe('selectionMessage', () => {
  it('자동 수집과 같은 대화 id 를 쓴다 (대화 화면이 아니면 둘 다 new)', () => {
    const onHome = selectionMessage(chatgpt, ' 팀 결정 ', 'https://chatgpt.com/', '');
    expect(onHome).toMatchObject({ conversationId: 'new', site: 'chatgpt', text: '팀 결정', conversationTitle: '(제목 없음)' });
    expect(onHome?.conversationId).toBe(chatgpt.conversationIdOf('https://chatgpt.com/'));

    const inChat = selectionMessage(chatgpt, '팀 결정', 'https://chatgpt.com/c/abc-12?model=x', 'MVP 범위 - ChatGPT');
    expect(inChat).toMatchObject({ conversationId: 'abc-12', conversationTitle: 'MVP 범위' });
  });

  it('두 글자보다 짧으면 보내지 않는다', () => {
    expect(selectionMessage(chatgpt, ' a ', 'https://chatgpt.com/', '')).toBeNull();
  });
});

describe('지원 사이트 목록', () => {
  it('콘텐츠 스크립트 주소와 출처 판정이 같은 목록에서 나온다', () => {
    expect(CHAT_PAGE_MATCHES).toEqual(['https://chatgpt.com/*', 'https://chat.openai.com/*']);
    expect(siteForUrl('https://chat.openai.com/c/x')).toBe(chatgpt);
    expect(siteForUrl('http://chatgpt.com/')).toBeNull();
    expect(siteForUrl('')).toBeNull();
  });
});

describe('collectResultToast', () => {
  it('수집기가 따로 보관한 발화가 있으면 "이미 보낸 내용" 대신 그 사실을 알린다', () => {
    expect(collectResultToast({ ok: true, newMessages: 0, intakeIssues: 2 })).toMatchObject({ tone: 'error', text: expect.stringContaining('2개는') });
    expect(collectResultToast({ ok: true, newMessages: 0, intakeIssues: 0 }).text).toBe('이미 보낸 내용이에요');
    expect(collectResultToast({ ok: false, error: '로컬 수집기 연결 실패' })).toEqual({ type: 'toast', text: '로컬 수집기 연결 실패', tone: 'error' });
  });
});
