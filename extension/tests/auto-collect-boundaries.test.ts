// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/boundaries"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from '#imports';
import type { CollectedMessage } from '@shared/collector';
import { startAutoCollect } from '@/lib/auto-collect';
import { chatgpt } from '@/lib/sites/chatgpt';

const user = (id: string, text = id) => `<div data-message-author-role="user" data-message-id="${id}"><div class="whitespace-pre-wrap">${text}</div></div>`;
const assistant = (id: string, text = id) => `<div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown">${text}</div></div>`;
let active = true;
let sent: CollectedMessage[][] = [];
let cleanup: (() => void)[] = [];
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const add = (html: string) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html);
function start() {
  const overlay = document.createElement('div'); document.body.append(overlay);
  return startAutoCollect({ setTimeout, onInvalidated: (fn: () => void) => cleanup.push(fn) } as unknown as ContentScriptContext,
    { site: chatgpt, overlay, isActive: () => active,
      send: async (messages) => { sent.push(messages); return { ok: true, newMessages: messages.length, intakeIssues: 0 }; }, showError: () => {} });
}
beforeEach(() => {
  vi.useFakeTimers(); active = true; sent = []; cleanup = [];
  document.body.innerHTML = `<main>${user('old-u')}${assistant('old-a')}</main><aside></aside>`;
});
afterEach(() => { cleanup.forEach(fn => fn()); vi.useRealTimers(); document.body.replaceChildren(); });

it('대화 밖 화면 변화가 계속되어도 완성된 마지막 답변을 저장한다', async () => {
  start(); await tick(2000);
  add(user('new-u') + assistant('new-a'));
  for (let i = 0; i < 10; i++) { document.querySelector('aside')!.textContent = String(i); await tick(500); }
  expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:new-u', 'chatgpt:new-a']);
});

it('숨겨진 중지 버튼은 완료된 답변을 생성 중으로 오인하지 않는다', () => {
  document.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop generating" hidden></button>');
  expect(chatgpt.extract().messages.map(m => m.id)).toEqual(['chatgpt:old-u', 'chatgpt:old-a']);
});

it('켜기 전 질문의 늦은 답변은 제외하고 켠 뒤 새 질문과 답변만 저장한다', async () => {
  active = false;
  document.body.innerHTML = `<main>${user('off-u')}</main>`;
  const control = start(); await tick(2000);
  control.activityChanged(false, true); active = true;
  add(assistant('off-a') + user('on-u') + assistant('on-a'));
  await tick(4000);
  expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:on-u', 'chatgpt:on-a']);
});

it('켜기 직후 2초 안에 작성한 새 질문도 지연 기준선에 삼키지 않는다', async () => {
  start(); add(user('immediate-u') + assistant('immediate-a'));
  await tick(4000);
  expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:immediate-u', 'chatgpt:immediate-a']);
});

it('답변 완료 직후 끄면 2초 대기분부터 저장하고 중지 완료로 답한다', async () => {
  const control = start(); await tick(2000);
  add(user('on-u') + assistant('on-a'));
  await expect(control.prepareStop()).resolves.toEqual({ ok: true });
  active = false; control.activityChanged(true, false);
  add(user('off-u') + assistant('off-a')); await tick(4000);
  expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:on-u', 'chatgpt:on-a']);
});

it('생성 중 끄면 그 답변만 완료까지 기다리고 새 질문은 제외한다', async () => {
  const control = start(); await tick(2000);
  add(user('on-u') + assistant('on-a', '생성 중'));
  document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">중지</button>');
  let done = false;
  const stopping = control.prepareStop().then(r => { done = true; return r; });
  await tick(3000); expect(done).toBe(false);
  document.querySelector('[data-message-id="on-a"] .markdown')!.textContent = '완성된 답변';
  document.querySelector('[data-testid="stop-button"]')!.setAttribute('hidden', '');
  add(user('after-stop-u') + assistant('after-stop-a'));
  await tick(2000);
  await expect(stopping).resolves.toEqual({ ok: true });
  expect(sent.flat().map(m => [m.id, m.text])).toEqual([['chatgpt:on-u', 'on-u'], ['chatgpt:on-a', '완성된 답변']]);
  active = false; control.activityChanged(true, false);
  await tick(3000); expect(sent.flat()).toHaveLength(2);
});

it('다시 켜도 꺼져 있던 대화는 소급 저장하지 않는다', async () => {
  const control = start(); await tick(2000);
  add(user('first-u') + assistant('first-a')); await control.prepareStop();
  active = false; control.activityChanged(true, false);
  add(user('off-u') + assistant('off-a')); await tick(2000);
  control.activityChanged(false, true); active = true;
  add(user('second-u') + assistant('second-a')); await tick(4000);
  expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:first-u', 'chatgpt:first-a', 'chatgpt:second-u', 'chatgpt:second-a']);
});

it('질문 직후 중지 표시가 생기기 전에 꺼도 그 답변까지 기다린다', async () => {
  const control = start(); await tick(2000);
  add(user('on-u'));
  let done = false;
  const stopping = control.prepareStop().then(r => { done = true; return r; });
  await tick(2000); expect(done).toBe(false);
  add(assistant('on-a'));
  await tick(2000);
  await expect(stopping).resolves.toEqual({ ok: true });
  expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:on-u', 'chatgpt:on-a']);
});
