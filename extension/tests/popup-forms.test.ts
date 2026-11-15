// @vitest-environment happy-dom
// 팝업 입력 회귀 시험: 종료 시각 저장과 늦게 도착하는 팀 이름
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { CollectionLimits } from '@/entrypoints/popup/CollectionControls';
import { SetupForm } from '@/entrypoints/popup/SetupForm';
import { settingsItem, type Settings } from '@/lib/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const settings = (changes: Partial<Settings>): Settings => ({ ...(settingsItem.fallback as Settings), ...changes });
const render = (el: ReturnType<typeof createElement>) => act(() => root.render(el));

// React 가 듣는 input 이벤트로 값을 바꾼다 (value 세터를 직접 부르면 React 가 변화를 못 본다)
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  fakeBrowser.reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('종료 시각 입력', () => {
  const now = new Date('2026-11-28T18:20').getTime();
  const click = (label: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  const submit = () => act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(now));

  it('달력에서 달이 바뀐 날짜와 시간을 고르고 설정을 누를 때 한 번만 저장한다', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    await render(createElement(CollectionLimits, { settings: settings({ endsAt: new Date('2026-11-29T18:30').toISOString() }) }));
    await click('종료 날짜와 시각 선택');
    await click('12월 2일 수요일');
    const input = host.querySelector<HTMLInputElement>('input[type="time"]')!;
    await act(() => type(input, '09:30'));
    expect(input.value).toBe('09:30');
    expect(send).not.toHaveBeenCalled();
    await submit();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ type: 'updateSettings', patch: { endsAt: new Date('2026-12-02T09:30').toISOString() } });
    expect(host.querySelector('form')).toBeNull();
  });

  it('타이머를 누른 순간부터 종료까지의 시간만 저장하고 자동 수집을 켜지 않는다', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    await render(createElement(CollectionLimits, { settings: settings({ endsAt: new Date(now - 60_000).toISOString(), autoCollect: false }) }));
    for (const [label, hours] of [['3시간', 3], ['6시간', 6], ['12시간', 12], ['1일', 24], ['3일', 72], ['7일', 168]] as const) {
      await click(`지금부터 ${label}`);
      expect(send).toHaveBeenLastCalledWith({ type: 'updateSettings', patch: { endsAt: new Date(now + hours * 3_600_000).toISOString() } });
    }
    expect(send).toHaveBeenCalledTimes(6);
  });

  it('지난 시각과 저장 실패를 설정 섹션 안에서 알려 준다', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: false, error: '수집기가 응답하지 않아요.' } as never);
    await render(createElement(CollectionLimits, { settings: settings({}) }));
    await click('종료 날짜와 시각 선택');
    const input = host.querySelector<HTMLInputElement>('input[type="time"]')!;
    await act(() => type(input, '09:30'));
    await submit();
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('7일 이내');
    await act(() => type(input, '21:30'));
    await submit();
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('수집기가 응답하지 않아요.');
    expect(host.querySelector('form')).not.toBeNull();
  });
});

describe('첫 설정 화면', () => {
  it('팝업을 연 뒤 수집기 상태로 늦게 온 팀 이름·사용자를 보여 준다', async () => {
    const props = { firstTime: true, onSaved: () => {} };
    await render(createElement(SetupForm, { ...props, initial: settings({}) }));
    const teamInput = () => host.querySelectorAll('input')[0] as HTMLInputElement;
    expect(teamInput().value).toBe('');
    await render(createElement(SetupForm, { ...props, initial: settings({ teamName: '온길', userName: '김도윤' }) }));
    expect(teamInput().value).toBe('온길');
  });
});
