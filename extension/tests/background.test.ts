// entrypoints/background.ts 를 가짜 browser 위에서 띄우고, 로컬 수집기(native host)는 메서드별 가짜 응답으로 바꾼다
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ExtStatus } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';
import background from '@/entrypoints/background';
import { collectStateItem, settingsItem } from '@/lib/settings';
import { LOCAL_WEB_URL, PRODUCTION_WEB_URL } from '@/lib/web-url';

const STATUS: ExtStatus = {
  version: '1',
  configured: true,
  autoCollect: true,
  turnsPerBatch: 10,
  bufferedTurns: 0,
  endsAt: '2026-11-10T00:00:00+00:00',
  lastCollectedAt: null,
  lastClassifier: null,
  teamName: '팀',
  userName: '나',
  projectTopic: '주제',
  recent: [],
};

interface NativeRequest {
  method: string;
  params: { messages?: CollectedMessage[]; flush?: boolean };
}

const nativeCalls: NativeRequest[] = [];
let appendIssues: unknown[] = [];
// 메서드별로 바꿔 줄 응답. 'unreachable' 이면 native host 자체에 닿지 못한 것처럼 던진다
let overrides: Record<string, object | 'unreachable'> = {};

async function fakeCollector(_host: string, request: NativeRequest) {
  nativeCalls.push(request);
  const override = overrides[request.method];
  if (override === 'unreachable') throw new Error('Specified native messaging host not found.');
  if (override) return override;
  if (request.method === 'candidates.list') return { ok: true, result: { cards: [], status: STATUS } };
  if (request.method === 'turns.append') {
    return { ok: true, result: { newMessages: request.params.messages!.length, queued: true, intakeIssues: appendIssues } };
  }
  return { ok: true, result: { method: request.method } };
}

const messages = (count: number): CollectedMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    site: 'chatgpt',
    role: i % 2 ? 'assistant' : 'user',
    text: `발화 ${i}`,
    conversationId: 'c1',
    conversationTitle: '대화',
    url: 'https://chatgpt.com/c/c1',
    collectedAt: '2026-11-09T12:00:00Z',
  }));

// Chrome 처럼 sendResponse 로 받은 답을 돌려준다. Chrome 148 미만은 리스너가 돌려준 Promise 를 답으로 쓰지 않으므로,
// 리스너가 true(답할 때까지 채널을 열어 둠)를 돌려주는지도 확인한다
async function send(message: unknown, sender: object) {
  let respond: (response: unknown) => void = () => {};
  const response = new Promise((resolve) => (respond = resolve));
  const [keepsChannelOpen] = await fakeBrowser.runtime.onMessage.trigger(message, sender, respond);
  expect(keepsChannelOpen).toBe(true);
  return response;
}
const fromPage = (url: string) => ({ url, tab: { id: 1 }, id: fakeBrowser.runtime.id });
const fromPopup = () => ({ id: fakeBrowser.runtime.id, url: `chrome-extension://${fakeBrowser.runtime.id}/popup.html` });
const lastError = async () => (await collectStateItem.getValue()).lastError;
const calledMethods = () => nativeCalls.map((c) => c.method);
const appendCalls = () => nativeCalls.filter((c) => c.method === 'turns.append');
const useWebUrl = async (webUrl: string) => settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl });
// 뒤따르는 비동기 처리(오류 기록, 두 번째 안내 전송 등)가 있으면 끝나게 둔다
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// fakeBrowser 에 contextMenus.onClicked 가 없어서 등록된 처리기를 직접 받아 둔다
let menuClicked: (info: object, tab: object) => void = () => {};

beforeEach(async () => {
  fakeBrowser.reset();
  appendIssues = [];
  overrides = {};
  vi.spyOn(fakeBrowser.runtime, 'sendNativeMessage').mockImplementation(fakeCollector as never);
  vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue(undefined);
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation((listener) => void (menuClicked = listener as never));
  background.main();
  await settle(); // 시작할 때 하는 상태 새로 고침이 끝나게 둔다
  nativeCalls.length = 0;
});

describe('웹 화면의 수집기 RPC', () => {
  it('설정한 주소가 배포 주소면 localhost:3000 페이지의 요청은 수집기에 닿지 않는다', async () => {
    await useWebUrl(PRODUCTION_WEB_URL);
    const result = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://localhost:3000/review'));
    expect(result).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    expect(calledMethods()).not.toContain('privacy.list');
  });

  it('로컬 개발 주소를 골랐으면 그 주소의 페이지만 수집기를 부를 수 있다', async () => {
    await useWebUrl(LOCAL_WEB_URL);
    const result = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://localhost:3000/review'));
    expect(result).toEqual({ ok: true, result: { method: 'privacy.list' } });
    const other = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://127.0.0.1:3000/review'));
    expect(other).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
  });
});

describe('대화 보내기', () => {
  const chatPage = fromPage('https://chatgpt.com/c/c1');

  it('200개가 넘는 수동 보내기는 200개씩 나눠 보내고 마지막 묶음에만 flush 를 붙인다', async () => {
    const result = await send({ type: 'collect', trigger: 'manual', messages: messages(450) }, chatPage);
    expect(appendCalls().map((c) => c.params.messages?.length)).toEqual([200, 200, 50]);
    expect(appendCalls().map((c) => c.params.flush)).toEqual([false, false, true]);
    expect(result).toEqual({ ok: true, newMessages: 450, intakeIssues: 0 });
  });

  it('자동 수집은 flush 없이 보낸다', async () => {
    await send({ type: 'collect', trigger: 'auto', messages: messages(3) }, chatPage);
    expect(appendCalls().map((c) => c.params.flush)).toEqual([false]);
  });

  it('수집기가 따로 보관한 발화 수를 돌려준다', async () => {
    appendIssues = [{ id: 'issue-1', reason: 'invalid_message' }];
    const result = await send({ type: 'collect', trigger: 'manual', messages: messages(2) }, chatPage);
    expect(result).toEqual({ ok: true, newMessages: 2, intakeIssues: 1 });
  });

  it('채팅 화면이 아닌 페이지의 collect 는 거절한다', async () => {
    const result = await send({ type: 'collect', trigger: 'manual', messages: messages(1) }, fromPage('https://example.com/'));
    expect(result).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
  });
});

describe('우클릭 메뉴로 선택한 내용 보내기', () => {
  it('저장 뒤 안내 전송이 실패해도 오류로 남기지 않는다 (콘텐츠 스크립트가 없는 탭)', async () => {
    const toast = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('Receiving end does not exist.'));
    menuClicked({ menuItemId: 'syncup-send-selection', selectionText: '팀 결정 내용' }, { id: 7, url: 'https://chatgpt.com/c/c1', title: '대화' });
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    await settle();
    expect(calledMethods()).toContain('turns.append');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(await lastError()).toBeNull();
  });
});

describe('팝업에 보이는 마지막 오류', () => {
  it('수집기가 거절한 오류는 상태 새로 고침이 성공해도 남는다', async () => {
    overrides['collection.flush'] = { ok: false, error: '수집이 활성화되지 않았습니다.' };
    expect(await send({ type: 'flush' }, fromPopup())).toEqual({ ok: false, error: '수집이 활성화되지 않았습니다.' });
    await send({ type: 'refresh' }, fromPopup());
    expect(await lastError()).toBe('수집이 활성화되지 않았습니다.');
  });

  it('수집기에 닿지 못한 오류는 상태 새로 고침이 성공하면 지운다', async () => {
    overrides['collection.flush'] = 'unreachable';
    await send({ type: 'flush' }, fromPopup());
    expect(await collectStateItem.getValue()).toMatchObject({ lastError: 'Specified native messaging host not found.', unreachable: true });
    await send({ type: 'refresh' }, fromPopup());
    expect(await lastError()).toBeNull();
  });

  it('설정 저장은 뒤따르는 새로 고침이 실패해도 실패로 돌려준다', async () => {
    overrides['candidates.list'] = { ok: false, error: '팀 서버 확인 실패' };
    const result = await send({ type: 'updateSettings', patch: { projectTopic: '주제' } }, fromPopup());
    expect(result).toEqual({ ok: false, error: '팀 서버 확인 실패' });
  });

  it('웹 화면 RPC 의 실패는 웹에만 돌려주고 팝업 오류로 남기지 않는다', async () => {
    await useWebUrl(LOCAL_WEB_URL);
    overrides['privacy.list'] = { ok: false, error: '팀 접근 불가' };
    const result = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://localhost:3000/review'));
    expect(result).toEqual({ ok: false, error: '팀 접근 불가' });
    expect(await lastError()).toBeNull();
  });
});
