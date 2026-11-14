// @vitest-environment happy-dom
// 프로젝트 주제(팀 공유): 주제가 있으면 '수정' → 확인(예/아니오) 뒤에만 고치고, 처음 설정이면 바로 쓴다
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOPIC_EDIT_CONFIRM } from '@shared/team-topic';
import { TopicField } from '@/entrypoints/popup/TopicField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const input = () => host.querySelector('input') as HTMLInputElement;
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const dialog = () => host.querySelector('[role="alertdialog"]');
const click = (el: HTMLElement | undefined) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('프로젝트 주제 칸', () => {
  it('저장된 주제가 있으면 읽기 전용이고, 수정은 확인에서 "예"를 눌러야 열린다', async () => {
    const onChange = vi.fn();
    await act(() => root.render(createElement(TopicField, { value: '팀 AI 메모리', saved: '팀 AI 메모리', onChange })));
    expect(input().readOnly).toBe(true);
    expect(dialog()).toBeNull();

    await click(button('수정'));
    expect(dialog()?.textContent).toContain(TOPIC_EDIT_CONFIRM);
    await click(button('아니오'));
    expect(dialog()).toBeNull();
    expect(input().readOnly).toBe(true);

    await click(button('수정'));
    await click(button('예'));
    expect(dialog()).toBeNull();
    expect(input().readOnly).toBe(false);
    expect(button('수정')).toBeUndefined();
    await act(async () => type(input(), '알림 서비스'));
    expect(onChange).toHaveBeenLastCalledWith('알림 서비스');
  });

  it('처음 설정(저장된 주제 없음)이면 확인 없이 바로 쓸 수 있다', async () => {
    const onChange = vi.fn();
    await act(() => root.render(createElement(TopicField, { value: '', saved: '  ', onChange })));
    expect(input().readOnly).toBe(false);
    expect(button('수정')).toBeUndefined();
    await act(async () => type(input(), '첫 주제'));
    expect(onChange).toHaveBeenLastCalledWith('첫 주제');
  });
});
