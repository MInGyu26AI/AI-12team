// 팝업의 화면 구조 경고 (entrypoints/popup/useStructureWarning.ts). 활성 탭과 콘텐츠 스크립트 답은 가짜로 바꾼다
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadStructureWarning } from '@/entrypoints/popup/useStructureWarning';
import type { TabPingResult } from '@/lib/messages';

const GOOD: TabPingResult = { site: 'ChatGPT', onConversation: true, messageCount: 4, selector: 'turn-attr', guessedRoles: 0 };

const activeTab = (url: string, ping?: unknown) => {
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [{ id: 7, url }]) as never);
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async () => {
    if (ping === undefined) throw new Error('Could not establish connection');
    return ping;
  }) as never);
};

beforeEach(() => {
  vi.restoreAllMocks();
  fakeBrowser.reset();
});

describe('loadStructureWarning', () => {
  it('정상으로 읽히면 안내가 없다', async () => {
    activeTab('https://chatgpt.com/c/abc', GOOD);
    expect(await loadStructureWarning()).toBeNull();
  });

  it('대화 화면인데 한 건도 못 읽으면 안내와 복사용 진단 글을 돌려준다', async () => {
    activeTab('https://chatgpt.com/c/abc', {
      ...GOOD,
      messageCount: 0,
      selector: null,
      tried: [
        { name: 'author-role', count: 0 },
        { name: 'turn-attr', count: 0 },
      ],
    });
    const warning = await loadStructureWarning();
    expect(warning?.message).toContain('한 건도 읽지 못했어요');
    expect(warning?.diagnostics).toContain('전략별 개수: author-role=0, turn-attr=0');
    expect(warning?.diagnostics).toContain('판정: 주의 (no-messages)');
  });

  it('빈 본문이 많으면(시각화 위주 답변 등) 알린다', async () => {
    activeTab('https://chatgpt.com/c/abc', { ...GOOD, messageCount: 4, emptyBodies: 4 });
    expect((await loadStructureWarning())?.message).toContain('글이 비어 있었어요');
  });

  it('ChatGPT 탭이 아니거나 콘텐츠 스크립트가 답하지 않으면 안내가 없다 (그건 TabNotice 의 몫)', async () => {
    activeTab('https://example.com/', GOOD);
    expect(await loadStructureWarning()).toBeNull();
    activeTab('https://chatgpt.com/c/abc'); // 답 없음
    expect(await loadStructureWarning()).toBeNull();
  });
});
