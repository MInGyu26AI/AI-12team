// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/delayed"}
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from '#imports';
import { startAutoCollect } from '@/lib/auto-collect';
import { chatgpt } from '@/lib/sites/chatgpt';
import type { CollectedMessage } from '@shared/collector';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
it('수집을 켠 상태에서 늦게 채워지는 새 답변을 완료 후 전송한다', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main><div data-message-author-role="user" data-message-id="old"><div class="whitespace-pre-wrap">기존 질문</div></div></main>';
  const callbacks: (() => void)[] = [];
  const ctx = { setTimeout, onInvalidated: (f: () => void) => callbacks.push(f) } as unknown as ContentScriptContext;
  const sent: CollectedMessage[][] = [];
  const overlay = document.createElement('div'); document.body.append(overlay);
  startAutoCollect(ctx, { site: chatgpt, overlay, isActive: () => true,
    send: async (messages) => { sent.push(messages); return { ok: true, newMessages: messages.length, intakeIssues: 0 }; }, showError: () => {} });
  try {
    await vi.advanceTimersByTimeAsync(2000);
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="new-u"><div class="whitespace-pre-wrap">새 질문</div></div><div data-message-author-role="assistant" data-message-id="new-a"><div class="markdown"></div></div><button data-testid="stop-button">중지</button>');
    await vi.advanceTimersByTimeAsync(2100);
    expect(sent.flat().map(m => m.id)).toEqual(['chatgpt:new-u']);
    document.querySelector('.markdown')!.textContent = '완성된 새 답변';
    document.querySelector('[data-testid="stop-button"]')!.remove();
    await vi.advanceTimersByTimeAsync(2100);
    expect(sent.flat().map(m => [m.role, m.text])).toEqual([['user', '새 질문'], ['assistant', '완성된 새 답변']]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent.flat()).toHaveLength(2);
  } finally { callbacks.forEach(f => f()); }
});
