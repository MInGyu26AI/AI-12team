// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// 채팅 화면 콘텐츠 스크립트가 `sync.*` 요청만 탭 클라이언트로 넘기고 sendResponse 로 답하는지 (docs/sync-contract.md 4장).
// fetch 는 가짜다. 실제 chatgpt.com 에는 요청하지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from '#imports';
import aiChat from '@/entrypoints/ai-chat.content';

const session = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/chatgpt/session.json'), 'utf8')) // happy-dom 에서는 import.meta.url 이 file: 이 아니다;
const { expectedAccount, ...sessionBody } = session;

const invalidated: (() => void)[] = [];
const ctx = {
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  onInvalidated: (stop: () => void) => invalidated.push(stop),
} as unknown as ContentScriptContext;

type Listener = (message: unknown, sender: object, sendResponse: (response: unknown) => void) => unknown;
let listeners: Listener[] = [];
const requested: string[] = [];

/** 등록된 리스너를 차례로 불러 본다. 하나라도 true 를 돌려주면 채널이 열려 있는 것이다 */
const deliver = async (message: unknown) => {
  const sendResponse = vi.fn();
  const returned = listeners.map((listener) => listener(message, {}, sendResponse));
  await vi.waitFor(() => (returned.includes(true) ? expect(sendResponse).toHaveBeenCalled() : undefined));
  return { returned, sendResponse };
};

beforeEach(() => {
  fakeBrowser.reset();
  listeners = [];
  requested.length = 0;
  vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener').mockImplementation((listener) => void listeners.push(listener as never));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify(sessionBody), { status: 200 });
    }),
  );
  document.body.replaceChildren();
  aiChat.main(ctx);
});

afterEach(() => {
  invalidated.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
});

describe('채팅 화면의 sync.* 메시지', () => {
  it('sync.session 에 sendResponse 로 답하고 채널을 열어 둔다 (true)', async () => {
    const { returned, sendResponse } = await deliver({ type: 'sync.session' });
    expect(returned).toContain(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, account: expectedAccount, data: null });
    expect(requested).toEqual(['/api/auth/session']); // 같은 출처의 상대 주소
  });

  it('요청이 실패해도 던지지 않고 오류 분류로 답한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const { sendResponse } = await deliver({ type: 'sync.session' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'network' });
  });

  it('sync. 로 시작하지 않는 메시지는 클라이언트로 넘기지 않는다', async () => {
    for (const message of [{ type: 'ping' }, { type: 'toast', text: '안녕', tone: 'ok' }, { type: 'syncNow' }, {}, null]) {
      const sendResponse = vi.fn();
      listeners.forEach((listener) => listener(message, {}, sendResponse));
      expect(sendResponse.mock.calls.every(([r]) => r === undefined || (r as { site?: string }).site === 'ChatGPT')).toBe(true); // ping 답만 있을 수 있다
    }
    expect(requested).toEqual([]);
  });

  it('ping 에는 지금처럼 sendResponse 로 답하고 Promise 를 돌려주지 않는다', () => {
    const sendResponse = vi.fn();
    const returned = listeners.map((listener) => listener({ type: 'ping' }, {}, sendResponse));
    expect(returned.every((r) => r === undefined)).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ site: 'ChatGPT', onConversation: true, messageCount: 0, selector: null, guessedRoles: 0 });
  });

  it('ping·toast 리스너가 마지막으로 등록된다 (chat-page-messages 시험이 마지막 리스너를 ping 용으로 본다)', () => {
    const sendResponse = vi.fn();
    listeners.at(-1)!({ type: 'ping' }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalled();
  });
});
