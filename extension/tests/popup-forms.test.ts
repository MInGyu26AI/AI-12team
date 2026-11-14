// @vitest-environment happy-dom
// 팝업 입력 회귀 시험: 종료 시각은 입력 중에 되돌아가지 않고 칸을 벗어날 때 한 번 저장, 첫 설정 화면은 늦게 온 팀 이름을 받는다
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
  it('입력하는 동안은 되돌아가지 않고 저장도 안 하다가, 칸을 벗어나면 한 번 저장한다', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    await render(createElement(CollectionLimits, { settings: settings({ endsAt: '2099-11-14T12:00:00.000Z' }) }));
    const input = host.querySelector('input[type="datetime-local"]') as HTMLInputElement;

    await act(async () => type(input, '')); // 브라우저가 덜 찬 날짜를 빈 값으로 알릴 때
    expect(input.value).toBe('');
    await act(async () => type(input, '2099-11-15T09:30'));
    expect(input.value).toBe('2099-11-15T09:30');
    expect(send).not.toHaveBeenCalled();

    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: 'updateSettings', patch: { endsAt: new Date('2099-11-15T09:30').toISOString() } });
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
