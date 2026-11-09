// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/first"}
// 자동 수집의 기준선 · 디바운스 · 대화 이동 · 오류 안내 규칙. 화면 추출은 가짜 사이트로 바꾸고 시계는 가짜 타이머로 돌린다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from '#imports';
import type { CollectedMessage } from '@shared/collector';
import { startAutoCollect } from '@/lib/auto-collect';
import type { CollectResult } from '@/lib/messages';
import type { SiteAdapter } from '@/lib/sites';

let visible: string[] = []; // 지금 화면에 보이는 메시지 id
let active = true;
let answer: CollectResult = { ok: true, newMessages: 1, intakeIssues: 0 };
const sent: string[][] = [];
const errors: string[] = [];

const message = (id: string) => ({ id, text: id }) as CollectedMessage;
const site = { extract: () => ({ messages: visible.map(message), selector: 'fake', tried: [], guessedRoles: 0 }) } as unknown as SiteAdapter;
const invalidated: (() => void)[] = [];
const ctx = {
  setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  onInvalidated: (stop: () => void) => invalidated.push(stop),
} as unknown as ContentScriptContext;
const overlay = document.createElement('div');

// 화면에 메시지가 늘어난 것처럼: 보이는 목록을 바꾸고 DOM 을 건드려 MutationObserver 를 깨운다
async function show(...ids: string[]) {
  visible.push(...ids);
  document.body.append(document.createElement('p'));
  await vi.advanceTimersByTimeAsync(0);
}
const waitDebounce = () => vi.advanceTimersByTimeAsync(2000);

function start() {
  return startAutoCollect(ctx, {
    site,
    overlay,
    isActive: () => active,
    send: async (messages) => (sent.push(messages.map((m) => m.id)), answer),
    showError: (text) => errors.push(text),
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  document.body.replaceChildren(overlay);
  window.history.replaceState(null, '', '/c/first');
  visible = ['old-1', 'old-2'];
  active = true;
  answer = { ok: true, newMessages: 1, intakeIssues: 0 };
  sent.length = 0;
  errors.length = 0;
  start();
  await waitDebounce(); // 시작 2초 뒤 보이던 메시지가 기준선이 된다
});

afterEach(() => {
  invalidated.splice(0).forEach((stop) => stop()); // 시험마다 띄운 observer 를 멈춘다
  vi.useRealTimers();
});

describe('startAutoCollect', () => {
  it('열 때 있던 메시지는 보내지 않고, 새로 끝난 메시지만 화면 변화 2초 뒤에 보낸다', async () => {
    await show('new-1');
    expect(sent).toEqual([]);
    await waitDebounce();
    expect(sent).toEqual([['new-1']]);
  });

  it('2초 안에 연달아 바뀌면 마지막 변화 2초 뒤에 한 번만 보낸다', async () => {
    await show('new-1');
    await vi.advanceTimersByTimeAsync(1500);
    await show('new-2');
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([['new-1', 'new-2']]);
  });

  it('꺼져 있는 동안 나타난 메시지는 다시 켠 뒤에도 보내지 않는다', async () => {
    active = false;
    await show('while-off');
    active = true;
    await show('after-on');
    await waitDebounce();
    expect(sent).toEqual([['after-on']]);
  });

  it('다른 대화로 이동하면 그 대화에 보이는 메시지를 기준선으로 잡고, 그 뒤 새 메시지만 보낸다', async () => {
    window.history.pushState(null, '', '/c/second');
    visible = ['second-1', 'second-2'];
    await show();
    await waitDebounce();
    expect(sent).toEqual([]);
    await show('second-new');
    await waitDebounce();
    expect(sent).toEqual([['second-new']]);
  });

  it('우리 버튼 안의 변화로는 보내지 않는다', async () => {
    visible.push('new-1');
    overlay.append(document.createElement('span'));
    await waitDebounce();
    expect(sent).toEqual([]);
  });

  it('전송에 실패한 메시지는 다음 화면 변화 때 다시 보내고, 같은 오류 안내는 30초에 한 번만 띄운다', async () => {
    answer = { ok: false, error: '로컬 수집기 연결 실패' };
    await show('new-1');
    await waitDebounce();
    await show();
    await waitDebounce();
    expect(sent).toEqual([['new-1'], ['new-1']]);
    expect(errors).toEqual(['로컬 수집기 연결 실패']);

    await vi.advanceTimersByTimeAsync(30_000);
    await show();
    await waitDebounce();
    expect(errors).toHaveLength(2);
  });

  it('다른 오류는 바로 띄우고, 전송이 성공하면 같은 오류도 처음부터 다시 센다', async () => {
    answer = { ok: false, error: '오류 A' };
    await show('new-1');
    await waitDebounce();
    answer = { ok: false, error: '오류 B' };
    await show();
    await waitDebounce();
    answer = { ok: true, newMessages: 1, intakeIssues: 0 };
    await show();
    await waitDebounce();
    answer = { ok: false, error: '오류 B' };
    await show('new-2');
    await waitDebounce();
    expect(errors).toEqual(['오류 A', '오류 B', '오류 B']);
  });
});
