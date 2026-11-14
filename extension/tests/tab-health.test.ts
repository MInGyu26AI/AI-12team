// 채팅 탭 화면 읽기 점검과 배지 `!` (lib/tab-health.ts). browser API 는 가짜를 넣는다
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { TabPingResult } from '@/lib/messages';
import { CHAT_PAGE_MATCHES } from '@/lib/sites';
import {
  CONFIRM_POLLS,
  WARN_BADGE_COLOR,
  WARN_BADGE_TEXT,
  checkChatTabs,
  nextTabHealth,
  tabHealthItem,
  type TabHealthApi,
} from '@/lib/tab-health';

const GOOD: TabPingResult = { site: 'ChatGPT', onConversation: true, messageCount: 6, selector: 'turn-attr', guessedRoles: 0 };
const BROKEN: TabPingResult = { ...GOOD, messageCount: 0, selector: null }; // 대화 화면인데 0건
const LOADING_PAGE: TabPingResult = { ...GOOD, onConversation: false, messageCount: 0, selector: null };

let tabs: { id?: number }[] = [];
const answers = new Map<number, unknown>();
const badge = vi.fn();
const color = vi.fn();
const query = vi.fn(async (_info: { url: string[] }) => tabs);
const sendMessage = vi.fn(async (tabId: number, _message: object) => {
  if (!answers.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
  return answers.get(tabId);
});
const api: TabHealthApi = {
  tabs: { query, sendMessage },
  action: { setBadgeText: badge, setBadgeBackgroundColor: color },
};
const states = async () => tabHealthItem.getValue();

beforeEach(() => {
  fakeBrowser.reset();
  tabs = [{ id: 1 }];
  answers.clear();
  vi.clearAllMocks();
});

describe('nextTabHealth', () => {
  const idle = { streak: 0, flagged: false };

  it('정상이면 기록을 지운다', () => {
    expect(nextTabHealth({ streak: 5, flagged: true }, GOOD)).toEqual(idle);
  });

  it('경고가 CONFIRM_POLLS 번 이어져야 배지를 건다', () => {
    expect(CONFIRM_POLLS).toBe(2);
    const first = nextTabHealth(idle, BROKEN);
    expect(first).toEqual({ streak: 1, flagged: false });
    expect(nextTabHealth(first, BROKEN)).toEqual({ streak: 2, flagged: true });
  });

  it('중간에 정상이 끼면 처음부터 센다', () => {
    const first = nextTabHealth(idle, BROKEN);
    expect(nextTabHealth(nextTabHealth(first, GOOD), BROKEN)).toEqual({ streak: 1, flagged: false });
  });

  it('답이 없으면(null) 아무것도 바꾸지 않는다', () => {
    const before = { streak: 1, flagged: false };
    expect(nextTabHealth(before, null)).toBe(before);
    expect(nextTabHealth({ streak: 3, flagged: true }, null)).toEqual({ streak: 3, flagged: true });
  });

  it('대화 화면이 아닌 탭(새 대화 · 로딩)은 0건이어도 경고가 아니다', () => {
    expect(nextTabHealth(idle, LOADING_PAGE)).toEqual(idle);
  });
});

describe('checkChatTabs', () => {
  it('채팅 페이지 주소의 탭에만 ping 을 보낸다', async () => {
    answers.set(1, GOOD);
    await checkChatTabs(api);
    expect(query).toHaveBeenCalledWith({ url: CHAT_PAGE_MATCHES });
    expect(sendMessage).toHaveBeenCalledWith(1, { type: 'ping' });
  });

  it('첫 점검의 경고는 배지를 걸지 않고, 두 번째에 그 탭에 `!` 를 건다', async () => {
    answers.set(1, BROKEN);
    await checkChatTabs(api);
    expect(badge).not.toHaveBeenCalled();
    expect(await states()).toEqual({ '1': { streak: 1, flagged: false } });

    await checkChatTabs(api);
    expect(badge).toHaveBeenCalledWith({ tabId: 1, text: WARN_BADGE_TEXT });
    expect(color).toHaveBeenCalledWith({ tabId: 1, color: WARN_BADGE_COLOR });
    expect(await states()).toEqual({ '1': { streak: 2, flagged: true } });
  });

  it('걸려 있는 동안은 점검마다 배지를 다시 건다 (전체 새로 고침으로 사라질 수 있다)', async () => {
    answers.set(1, BROKEN);
    await checkChatTabs(api);
    await checkChatTabs(api);
    await checkChatTabs(api);
    expect(badge).toHaveBeenCalledTimes(2);
  });

  it('정상으로 돌아오면 탭 단위 배지를 지우고(null) 전역 배지로 돌아간다', async () => {
    answers.set(1, BROKEN);
    await checkChatTabs(api);
    await checkChatTabs(api);
    badge.mockClear();
    answers.set(1, GOOD);
    await checkChatTabs(api);
    expect(badge).toHaveBeenCalledOnce();
    expect(badge).toHaveBeenCalledWith({ tabId: 1, text: null });
    expect(await states()).toEqual({ '1': { streak: 0, flagged: false } });
  });

  it('탭마다 따로 센다: 한 탭이 깨져도 다른 탭에는 배지를 걸지 않는다', async () => {
    tabs = [{ id: 1 }, { id: 2 }];
    answers.set(1, BROKEN);
    answers.set(2, GOOD);
    await checkChatTabs(api);
    await checkChatTabs(api);
    expect(badge.mock.calls.map(([d]) => d.tabId)).toEqual([1]);
  });

  it('답이 없는 탭(콘텐츠 스크립트 없음 · 확장을 새로 고친 뒤)은 단정하지 않는다', async () => {
    await checkChatTabs(api); // answers 비어 있음 → sendMessage 가 던진다
    await checkChatTabs(api);
    expect(badge).not.toHaveBeenCalled();
    expect(await states()).toEqual({ '1': { streak: 0, flagged: false } });
  });

  it('닫힌 탭의 기록은 다음 점검에서 빠진다', async () => {
    tabs = [{ id: 1 }, { id: 2 }];
    answers.set(1, BROKEN);
    answers.set(2, BROKEN);
    await checkChatTabs(api);
    tabs = [{ id: 2 }];
    await checkChatTabs(api);
    expect(Object.keys(await states())).toEqual(['2']);
  });

  it('id 없는 탭은 건너뛴다', async () => {
    tabs = [{}, { id: 3 }];
    answers.set(3, GOOD);
    await checkChatTabs(api);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('멈춘 탭이 있어도 점검이 끝난다 (ping 시간 제한)', async () => {
    vi.useFakeTimers();
    try {
      sendMessage.mockImplementationOnce(() => new Promise(() => {}));
      const done = checkChatTabs(api);
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      expect(await states()).toEqual({ '1': { streak: 0, flagged: false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('API 가 던져도 던지지 않는다 (상태 새로 고침을 막지 않는다)', async () => {
    query.mockRejectedValueOnce(new Error('tabs unavailable'));
    await expect(checkChatTabs(api)).resolves.toBeUndefined();
  });
});
