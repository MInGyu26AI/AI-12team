// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// 채팅 화면 콘텐츠 스크립트가 팝업 ping 과 백그라운드 toast 에 어떻게 답하는지.
// Chrome 148 미만은 리스너가 돌려준 Promise 를 답으로 쓰지 않으므로 ping 은 sendResponse 로 답해야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from '#imports';
import aiChat from '@/entrypoints/ai-chat.content';
import { settingsItem } from '@/lib/settings';

const invalidated: (() => void)[] = [];
const ctx = {
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  onInvalidated: (stop: () => void) => invalidated.push(stop),
} as unknown as ContentScriptContext;

// 콘텐츠 스크립트가 등록한 리스너를 직접 불러 돌려준 값을 그대로 본다 (fakeBrowser 의 trigger 는 Promise 를 풀어 버린다)
let onMessage: (message: unknown, sender: object, sendResponse: (response: unknown) => void) => unknown = () => undefined;
const deliver = (message: unknown) => {
  const sendResponse = vi.fn();
  return { returned: onMessage(message, {}, sendResponse), sendResponse };
};
const toastText = () => document.querySelector('#syncup-root')?.shadowRoot?.querySelector('.toast')?.textContent;

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener').mockImplementation((listener) => void (onMessage = listener as never));
  document.body.replaceChildren();
  aiChat.main(ctx);
});

afterEach(() => invalidated.splice(0).forEach((stop) => stop()));

describe('채팅 화면이 받는 메시지', () => {
  it('ping 에는 sendResponse 로 바로 답하고 Promise 를 돌려주지 않는다', async () => {
    const { returned, sendResponse } = deliver({ type: 'ping' });
    expect(returned).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ site: 'ChatGPT', onConversation: true, messageCount: 0, selector: null, guessedRoles: 0 });
  });

  it('toast 는 화면에 띄우고 답하지 않는다 (채널을 열어 두지 않음)', async () => {
    const { returned, sendResponse } = deliver({ type: 'toast', text: '분류 대기함에 저장했어요', tone: 'ok' });
    expect(returned).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(toastText()).toBe('분류 대기함에 저장했어요');
  });
});

describe('"싱크업에 보내기" 버튼', () => {
  it('수집이 꺼져 있으면 보내지 않고 켜라고 안내한다 (거절될 메시지를 기준선에 넣지 않게)', async () => {
    await settingsItem.setValue({ ...settingsItem.fallback, teamName: '팀', projectTopic: '주제', userName: '나', autoCollect: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const toBackground = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<main><div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">발표는 금요일</div></div></main>',
    );
    document.querySelector('#syncup-root')!.shadowRoot!.querySelector<HTMLButtonElement>('button.all')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toBackground).not.toHaveBeenCalled();
    expect(toastText()).toBe('수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요');
  });
});
