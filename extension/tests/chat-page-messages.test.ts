// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// 채팅 화면 콘텐츠 스크립트가 팝업 ping 과 백그라운드 toast 에 어떻게 답하는지.
// Chrome 148 미만은 리스너가 돌려준 Promise 를 답으로 쓰지 않으므로 ping 은 sendResponse 로 답해야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from '#imports';
import aiChat from '@/entrypoints/ai-chat.content';

const invalidated: (() => void)[] = [];
const ctx = {
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  onInvalidated: (stop: () => void) => invalidated.push(stop),
} as unknown as ContentScriptContext;

const deliver = async (message: unknown) => {
  const sendResponse = vi.fn();
  const [returned] = await fakeBrowser.runtime.onMessage.trigger(message, {}, sendResponse);
  return { returned, sendResponse };
};
const toastText = () => document.querySelector('#syncup-root')?.shadowRoot?.querySelector('.toast')?.textContent;

beforeEach(() => {
  fakeBrowser.reset();
  document.body.replaceChildren();
  aiChat.main(ctx);
});

afterEach(() => invalidated.splice(0).forEach((stop) => stop()));

describe('채팅 화면이 받는 메시지', () => {
  it('ping 에는 sendResponse 로 바로 답하고 Promise 를 돌려주지 않는다', async () => {
    const { returned, sendResponse } = await deliver({ type: 'ping' });
    expect(returned).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ site: 'ChatGPT', onConversation: true, messageCount: 0, selector: null, guessedRoles: 0 });
  });

  it('toast 는 화면에 띄우고 답하지 않는다 (채널을 열어 두지 않음)', async () => {
    const { returned, sendResponse } = await deliver({ type: 'toast', text: '분류 대기함에 저장했어요', tone: 'ok' });
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(toastText()).toBe('분류 대기함에 저장했어요');
  });
});
