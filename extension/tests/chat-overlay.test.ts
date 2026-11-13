// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://chatgpt.com/c/test"}
// 채팅 화면의 "싱크 맞추기"·"팀 기록 불러오기" 버튼. 백그라운드와 입력창은 가짜로 두고, 실제 chatgpt.com 에는 요청하지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { SyncNowResult } from '@shared/bridge';
import type { RelatedCard } from '@shared/types';
import { createChatOverlay, syncNowToast, type ChatOverlay, type OverlayActions } from '@/lib/chat-overlay';
import { fetchTeamRecord } from '@/lib/team-record';

const result = (patch: Partial<SyncNowResult>): SyncNowResult => ({ sync: 'ran', newTurns: 0, flushed: false, ...patch });

describe('싱크 맞추기 결과 안내 (syncNowToast)', () => {
  it.each<[string, SyncNowResult, string, 'ok' | 'error']>([
    ['새 턴을 가져오고 분류 시작', result({ newTurns: 3, flushed: true }), '새 대화 3턴을 가져왔어요 · 분류를 시작했어요', 'ok'],
    ['가져올 것이 없고 분류 시작', result({ flushed: true }), '새로 가져올 대화가 없어요 · 분류를 시작했어요', 'ok'],
    ['수집 중이 아니라 분류 못 함', result({ newTurns: 1, blockedReason: '수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요' }), '새 대화 1턴을 가져왔어요 · 수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요', 'error'],
    ['동기화 꺼짐, 분류만', result({ sync: 'off', flushed: true }), '프로젝트 동기화가 꺼져 있어요 · 분류를 시작했어요', 'ok'],
    ['쉬는 중', result({ sync: 'resting', flushed: true }), 'ChatGPT 요청 제한으로 쉬는 중이에요. 잠시 뒤에 다시 눌러 주세요 · 분류를 시작했어요', 'error'],
    ['탭 없음', result({ sync: 'no-tab' }), 'chatgpt.com 탭을 하나 열어 두세요', 'error'],
    ['이미 도는 중', result({ sync: 'busy', flushed: true }), '이미 동기화하는 중이에요 · 분류를 시작했어요', 'ok'],
    ['실패', result({ sync: 'failed' }), '동기화하지 못했어요. 팝업에서 상태를 확인해 주세요', 'error'],
  ])('%s', (_name, input, text, tone) => {
    expect(syncNowToast(input)).toEqual({ text, tone });
  });
});

let overlay: ChatOverlay;
const toastText = () => overlay.host.shadowRoot!.querySelector('.toast')!.textContent;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  fakeBrowser.reset();
  document.body.replaceChildren();
});
afterEach(() => {
  overlay?.host.remove();
  vi.restoreAllMocks();
});

const mount = (fetchTeamRecord?: OverlayActions['fetchTeamRecord']) => {
  overlay = createChatOverlay({ fetchTeamRecord });
  document.body.append(overlay.host);
};

describe('"싱크 맞추기" 버튼', () => {
  it('syncNow(reason: button)를 백그라운드로 보내고 결과를 안내한다', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true, result: result({ newTurns: 2, flushed: true }) } as never);
    mount();
    overlay.syncButton.click();
    expect(overlay.syncButton.disabled).toBe(true); // 도는 동안 다시 누르지 못하게
    expect(toastText()).toBe('동기화하는 중이에요…');
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'syncNow', params: { reason: 'button' } });
    expect(toastText()).toBe('새 대화 2턴을 가져왔어요 · 분류를 시작했어요');
    expect(overlay.syncButton.disabled).toBe(false);
  });

  it('백그라운드가 거절하면 그 문구를 보여 준다', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: false, error: '허용되지 않은 연결 화면' } as never);
    mount();
    overlay.syncButton.click();
    await settle();
    expect(toastText()).toBe('허용되지 않은 연결 화면');
    expect(overlay.syncButton.disabled).toBe(false);
  });

  it('확장이 업데이트돼 연결이 끊겼거나 답이 없으면 새로고침을 안내한다', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Extension context invalidated.'));
    mount();
    overlay.syncButton.click();
    await settle();
    expect(toastText()).toBe('확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요');
    expect(overlay.syncButton.disabled).toBe(false);
    send.mockResolvedValue(undefined as never);
    overlay.syncButton.click();
    await settle();
    expect(toastText()).toBe('확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요');
  });

  it('결과 모양이 어긋나면 읽지 못했다고 알린다', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    mount();
    overlay.syncButton.click();
    await settle();
    expect(toastText()).toBe('동기화 결과를 읽지 못했어요');
  });
});

describe('"팀 기록 불러오기" 버튼', () => {
  const card: RelatedCard = {
    relevance: 'related', status: 'approved', source: 'ChatGPT', masked: false, confidence: 0.9, is_new_topic: false, reason: null, due: null,
    is_change: false, id: 'd1', sentence: 'x', subtopic: '작업·결과물', tag: 'decision', topic_key: 'MVP 범위', content: '브라우저 확장 = MVP 포함', owner: '이서준',
  };
  const mountEditor = () => {
    document.body.insertAdjacentHTML('beforeend', '<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p><br></p></div></form>');
    const editor = document.querySelector<HTMLElement>('#prompt-textarea')!;
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      editor.replaceChildren();
      for (const line of (event as ClipboardEvent).clipboardData!.getData('text/plain').split('\n')) {
        const p = document.createElement('p');
        p.textContent = line;
        editor.append(p);
      }
    });
    return editor;
  };

  it('팀 기록을 입력창에 채우고 전송은 하지 않는다', async () => {
    const editor = mountEditor();
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    const fetchTeamRecord = vi.fn(async () => ({ cards: [card], conflicts: [] }));
    mount(fetchTeamRecord);
    overlay.recordButton.click();
    expect(overlay.recordButton.disabled).toBe(true);
    await settle();
    expect(fetchTeamRecord).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toContain('- [결정] MVP 범위: 브라우저 확장 = MVP 포함 (결정 이서준)');
    expect(toastText()).toBe('팀 기록 1개를 입력창에 채웠어요. 질문을 덧붙여 직접 보내세요');
    expect(send).not.toHaveBeenCalled(); // 백그라운드로 아무것도 보내지 않는다 (전송 버튼도 누르지 않는다)
    expect(overlay.recordButton.disabled).toBe(false);
  });

  it("합칠 때 넘길 fetchTeamRecord 와 이으면 {type: 'teamRecord'} 요청부터 입력창 채우기까지 이어진다", async () => {
    const editor = mountEditor();
    const send = vi
      .spyOn(fakeBrowser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: true, result: { board: { items: [card] }, conflicts: { conflicts: [] } } } as never);
    mount(fetchTeamRecord);
    overlay.recordButton.click();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'teamRecord' });
    expect(editor.textContent).toContain('- [결정] MVP 범위: 브라우저 확장 = MVP 포함 (결정 이서준)');
    expect(toastText()).toBe('팀 기록 1개를 입력창에 채웠어요. 질문을 덧붙여 직접 보내세요');
  });

  it('백그라운드가 수집기 오류를 주면 그 문구를 보여 주고 입력창은 건드리지 않는다', async () => {
    const editor = mountEditor();
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: false, error: '로컬 수집기 연결 실패' } as never);
    mount(fetchTeamRecord);
    overlay.recordButton.click();
    await settle();
    expect(toastText()).toBe('로컬 수집기 연결 실패');
    expect(editor.textContent).toBe('');
  });

  it('입력창을 못 찾으면 클립보드에 복사하고 붙여넣으라고 안내한다', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(async () => ({ cards: [card], conflicts: [] }));
    overlay.recordButton.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]).toEqual([expect.stringContaining('브라우저 확장 = MVP 포함')]);
    expect(toastText()).toBe('입력창에 바로 넣지 못해 클립보드에 복사했어요. 입력창에 붙여넣어 주세요');
  });

  it('입력창도 클립보드도 안 되면 오류로 알린다', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('denied')) }, configurable: true });
    mount(async () => ({ cards: [card], conflicts: [] }));
    overlay.recordButton.click();
    await settle();
    expect(toastText()).toBe('입력창에도 클립보드에도 넣지 못했어요. 브라우저 권한을 확인해 주세요');
  });

  it('팀 기록이 없거나 받아 오지 못하면 입력창은 건드리지 않고 이유를 알린다', async () => {
    const editor = mountEditor();
    mount(async () => ({ cards: [], conflicts: [] }));
    overlay.recordButton.click();
    await settle();
    expect(toastText()).toBe('팀 결정 기록이 아직 없어요. 개인 검토함에서 카드를 승인하면 불러올 수 있어요');
    expect(editor.textContent).toBe('');
    overlay.host.remove();
    mount(async () => Promise.reject(new Error('로컬 수집기 연결 실패')));
    overlay.recordButton.click();
    await settle();
    expect(toastText()).toBe('로컬 수집기 연결 실패');
    expect(editor.textContent).toBe('');
    expect(overlay.recordButton.disabled).toBe(false);
  });

  it('데이터를 받아 오는 함수를 아직 안 넘겼으면 연결 전이라고만 안내한다', async () => {
    mount();
    overlay.recordButton.click();
    await settle();
    expect(toastText()).toBe('팀 기록을 받아 올 연결이 아직 없어요');
    expect(overlay.recordButton.disabled).toBe(false);
  });
});
