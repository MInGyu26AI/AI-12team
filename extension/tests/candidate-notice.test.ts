import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import config from '@/wxt.config';
import {
  NOTICE_ID,
  announceCandidates,
  listenNoticeClick,
  newCandidateCount,
  noticeBaselineItem,
  noticeText,
  notifyNewCandidates,
  onNoticeClicked,
  reviewUrl,
  type NoticeBrowser,
} from '@/lib/candidate-notice';
import { settingsItem, type Settings } from '@/lib/settings';
import { DEFAULT_WEB_URL } from '@/lib/web-url';

function fakeApi() {
  const create = vi.fn<NoticeBrowser['notifications']['create']>(async () => 'id');
  const clear = vi.fn<NoticeBrowser['notifications']['clear']>(async () => true);
  const addListener = vi.fn<NoticeBrowser['notifications']['onClicked']['addListener']>();
  const openTab = vi.fn<NoticeBrowser['tabs']['create']>(async () => ({}));
  const api: NoticeBrowser = {
    notifications: { create, clear, onClicked: { addListener } },
    tabs: { create: openTab },
    runtime: { getURL: (path) => `chrome-extension://syncup${path}` },
  };
  return { api, create, clear, addListener, openTab };
}

const settings = (changes: Partial<Settings>): Settings => ({ ...(settingsItem.fallback as Settings), ...changes });

beforeEach(() => fakeBrowser.reset());

describe('newCandidateCount', () => {
  it('늘었을 때만 지금 수를 돌려준다', () => {
    expect(newCandidateCount(0, 3)).toBe(3);
    expect(newCandidateCount(2, 3)).toBe(3);
    expect(newCandidateCount(3, 3)).toBeNull(); // 같은 수
    expect(newCandidateCount(5, 2)).toBeNull(); // 줄어듦(승인·삭제)
    expect(newCandidateCount(0, 0)).toBeNull();
  });

  it('처음 본 값(이전 수 없음)이면 알리지 않는다', () => {
    expect(newCandidateCount(null, 7)).toBeNull();
  });
});

describe('notifyNewCandidates', () => {
  it('늘었을 때 "검토할 카드 N개" 알림을 한 번 띄운다', async () => {
    const { api, create } = fakeApi();
    expect(await notifyNewCandidates(1, 4, api)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(NOTICE_ID, {
      type: 'basic',
      iconUrl: 'chrome-extension://syncup/icon/128.png',
      title: '싱크업',
      message: '검토할 카드 4개',
    });
    expect(noticeText(4)).toBe('검토할 카드 4개');
  });

  it('같거나 줄었거나 처음이면 알림 API 를 부르지 않는다', async () => {
    const { api, create } = fakeApi();
    expect(await notifyNewCandidates(3, 3, api)).toBe(false);
    expect(await notifyNewCandidates(5, 2, api)).toBe(false);
    expect(await notifyNewCandidates(null, 9, api)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('알림이 실패해도 던지지 않고 false 를 돌려준다', async () => {
    const { api, create } = fakeApi();
    create.mockRejectedValue(new Error('notifications are disabled'));
    await expect(notifyNewCandidates(0, 2, api)).resolves.toBe(false);
  });
});

describe('announceCandidates (새로 고칠 때마다 부르는 진입점)', () => {
  it('처음 시작할 때는 알리지 않고 지금 수를 기억한다', async () => {
    const { api, create } = fakeApi();
    expect(await noticeBaselineItem.getValue()).toBeNull();
    expect(await announceCandidates(5, api)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(await noticeBaselineItem.getValue()).toBe(5);
  });

  it('처음 시작이 0개여도 그 뒤 늘면 알린다', async () => {
    const { api, create } = fakeApi();
    await announceCandidates(0, api);
    expect(await announceCandidates(2, api)).toBe(true);
    expect(create).toHaveBeenCalledWith(NOTICE_ID, expect.objectContaining({ message: '검토할 카드 2개' }));
  });

  it('같은 수로는 다시 알리지 않고, 줄었다가 다시 늘면 알린다', async () => {
    const { api, create } = fakeApi();
    await announceCandidates(0, api); // 시작
    await announceCandidates(3, api); // 알림 1
    await announceCandidates(3, api); // 같은 수
    await announceCandidates(3, api); // 같은 수
    expect(create).toHaveBeenCalledTimes(1);
    await announceCandidates(2, api); // 하나 승인
    expect(create).toHaveBeenCalledTimes(1);
    await announceCandidates(4, api); // 새 후보
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(NOTICE_ID, expect.objectContaining({ message: '검토할 카드 4개' }));
  });

  it('알림이 실패해도 던지지 않고 수는 기억한다 (30초마다 같은 실패를 되풀이하지 않는다)', async () => {
    const { api, create } = fakeApi();
    create.mockRejectedValue(new Error('denied'));
    await announceCandidates(0, api);
    await expect(announceCandidates(3, api)).resolves.toBe(false);
    expect(await noticeBaselineItem.getValue()).toBe(3);
    await announceCandidates(3, api);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('저장소가 던져도 던지지 않는다 (상태 새로 고침이 실패로 기록되면 안 된다)', async () => {
    const { api } = fakeApi();
    vi.spyOn(noticeBaselineItem, 'getValue').mockRejectedValueOnce(new Error('storage down'));
    await expect(announceCandidates(3, api)).resolves.toBe(false);
  });
});

describe('알림 누르기', () => {
  it('설정한 개인 검토함 주소의 /review 를 열고 알림을 지운다', async () => {
    const { api, openTab, clear } = fakeApi();
    await settingsItem.setValue(settings({ webUrl: 'http://localhost:3000' }));
    await onNoticeClicked(NOTICE_ID, api);
    expect(openTab).toHaveBeenCalledWith({ url: 'http://localhost:3000/review' });
    expect(clear).toHaveBeenCalledWith(NOTICE_ID);
  });

  it('주소를 설정하지 않았으면 기본 주소(web-url.ts)를 쓴다', async () => {
    const { api, openTab } = fakeApi();
    await onNoticeClicked(NOTICE_ID, api);
    expect(openTab).toHaveBeenCalledWith({ url: `${DEFAULT_WEB_URL}/review` });
    expect(reviewUrl({})).toBe(`${DEFAULT_WEB_URL}/review`);
  });

  it('다른 알림은 건드리지 않는다', async () => {
    const { api, openTab, clear } = fakeApi();
    await onNoticeClicked('other-extension-notice', api);
    expect(openTab).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('탭을 못 열어도 던지지 않고 알림은 그대로 둔다', async () => {
    const { api, openTab, clear } = fakeApi();
    openTab.mockRejectedValue(new Error('no window'));
    await expect(onNoticeClicked(NOTICE_ID, api)).resolves.toBeUndefined();
    expect(clear).not.toHaveBeenCalled();
  });

  it('listenNoticeClick 이 onClicked 에 리스너를 하나 붙이고, 그 리스너가 검토함을 연다', async () => {
    const { api, addListener, openTab } = fakeApi();
    listenNoticeClick(api);
    expect(addListener).toHaveBeenCalledTimes(1);
    addListener.mock.calls[0]![0](NOTICE_ID);
    await vi.waitFor(() => expect(openTab).toHaveBeenCalledWith({ url: `${DEFAULT_WEB_URL}/review` }));
  });
});

describe('manifest 권한 (wxt.config.ts)', () => {
  it('notifications 를 더하고 기존 권한은 그대로다', () => {
    const manifest = config.manifest as { permissions: string[] };
    expect(manifest.permissions).toEqual(['storage', 'tabs', 'nativeMessaging', 'contextMenus', 'alarms', 'notifications']);
  });
});
