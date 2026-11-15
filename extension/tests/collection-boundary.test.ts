import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { configureCollection } from '@/lib/collection-boundary';
import { collectionTransitionItem, settingsItem } from '@/lib/settings';
import { rpc } from '@/lib/collector-rpc';

vi.mock('@/lib/collector-rpc', () => ({ rpc: vi.fn(async () => ({ autoCollect: false })) }));
vi.mock('@/lib/collector-status', () => ({ refreshStatus: vi.fn(async () => {}) }));
vi.mock('@/lib/chatgpt-sync/scheduler', () => ({ isSyncedProjectPage: vi.fn(async () => false) }));
beforeEach(async () => {
  fakeBrowser.reset(); vi.clearAllMocks();
  await settingsItem.setValue({ ...settingsItem.fallback, autoCollect: true });
  vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7, url: 'https://chatgpt.com/c/test' }] as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('탭의 마지막 저장 확인 전에는 로컬 수집기를 끄지 않고 중지 중 상태를 유지한다', async () => {
  let finish!: (value: { ok: true }) => void;
  const tab = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const stop = configureCollection({ autoCollect: false });
  await vi.waitFor(() => expect(tab).toHaveBeenCalledWith(7, { type: 'collection.prepareStop' }));
  expect(await collectionTransitionItem.getValue()).toBe('stopping');
  expect(rpc).not.toHaveBeenCalled();
  await expect(configureCollection({ autoCollect: true })).rejects.toThrow('바꾸는 중');
  finish({ ok: true });
  await stop;
  expect(rpc).toHaveBeenCalledExactlyOnceWith('collection.configure', { autoCollect: false });
  expect(await collectionTransitionItem.getValue()).toBeNull();
});

it('마지막 저장 실패를 성공으로 숨기지 않고 수집 OFF와 경고를 함께 전달한다', async () => {
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: false, error: '저장 실패' } as never);
  await expect(configureCollection({ autoCollect: false })).rejects.toThrow('수집은 껐지만');
  expect(rpc).toHaveBeenCalledWith('collection.configure', { autoCollect: false });
  expect(await collectionTransitionItem.getValue()).toBeNull();
});

it('다시 켤 때 중지 대기를 실행하지 않고 켬 설정을 저장한다', async () => {
  await settingsItem.setValue({ ...settingsItem.fallback, autoCollect: false });
  const tab = vi.spyOn(fakeBrowser.tabs, 'sendMessage');
  await configureCollection({ autoCollect: true });
  expect(tab).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('collection.configure', { autoCollect: true });
});
