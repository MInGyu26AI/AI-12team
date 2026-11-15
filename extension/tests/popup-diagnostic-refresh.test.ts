// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { TabNotice } from '@/entrypoints/popup/TabNotice';
import { useStructureWarning } from '@/entrypoints/popup/useStructureWarning';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fakeBrowser.reset(); });

it('열린 팝업에서 늦게 표시된 답변을 다시 확인하고 메시지 수와 경고를 갱신한다', async () => {
  vi.useFakeTimers();
  let complete = false;
  vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7, url: 'https://chatgpt.com/c/test' }] as never);
  const ping = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(async () => ({
    site: 'ChatGPT', onConversation: true, messageCount: complete ? 4 : 2,
    selector: 'author-role', guessedRoles: 0, emptyBodies: complete ? 0 : 2,
  }) as never);
  function Warning() { return createElement('div', { id: 'warning' }, useStructureWarning()?.message); }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement('div', null, createElement(Warning), createElement(TabNotice, { autoCollect: false }))));
    expect(host.querySelector('#warning')!.textContent).toContain('글이 비어 있었어요');
    expect(host.textContent).toContain('메시지 2개');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelector('#warning')!.textContent).toContain('글이 비어 있었어요');
    complete = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelector('#warning')!.textContent).toBe('');
    expect(host.textContent).toContain('메시지 4개');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  const calls = ping.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000);
  expect(ping).toHaveBeenCalledTimes(calls);
});
