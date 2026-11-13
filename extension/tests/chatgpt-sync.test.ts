// 프로젝트만 수집 동기화(패스·스케줄러, docs/sync-contract.md 5장). background 를 가짜 browser 위에서 띄우고,
// 로컬 수집기(native host)와 chatgpt.com 탭의 콘텐츠 스크립트(sync.* 응답)는 모두 가짜로 둔다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { EXT_SYNC_NOW, type ExtStatus, type SyncNowResult } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';
import background from '@/entrypoints/background';
import { resetLeaderTabMemory } from '@/lib/chatgpt-sync/leader-tab';
import { appendChunks, runSyncPass, syncLeftoverItem, syncTiming } from '@/lib/chatgpt-sync/pass';
import { SYNC_SET_ERRORS } from '@/lib/chatgpt-sync/scheduler';
import { SYNC_ALARM, SYNC_DEFAULTS, syncStateItem, type SyncState } from '@/lib/chatgpt-sync/state';
import type { SyncConversationRef, TabSyncRequest } from '@/lib/messages';
import { settingsItem } from '@/lib/settings';
import { LOCAL_WEB_URL } from '@/lib/web-url';

const MIN = 60_000;
const ACCOUNT = 'a'.repeat(64);
const OTHER_ACCOUNT = 'b'.repeat(64);
const PROJECT = { gizmoId: 'g-p-team', name: '해커톤' };

let clock = 0;
const at = (minutes: number) => new Date(clock + minutes * MIN).toISOString();

// ── 가짜 로컬 수집기 ──
interface NativeRequest {
  method: string;
  params: { messages?: CollectedMessage[]; flush?: boolean; accountSync?: unknown };
}
const nativeCalls: NativeRequest[] = [];
let statusPatch: Partial<ExtStatus> = {};
let oldCollector = false;
let outsideWindowPerAppend = 0;
let nativeOverrides: Record<string, object> = {};

function collectorStatus(): ExtStatus {
  const status: ExtStatus = {
    version: '1',
    configured: true,
    autoCollect: true,
    turnsPerBatch: 10,
    bufferedTurns: 0,
    endsAt: at(24 * 60),
    lastCollectedAt: null,
    lastClassifier: null,
    teamName: '팀',
    userName: '나',
    projectTopic: '주제',
    recent: [],
    syncWindows: [{ start: at(-120), end: at(24 * 60) }],
    accountSync: { enabled: true, account: ACCOUNT, since: at(-120) },
    ...statusPatch,
  };
  if (oldCollector) {
    delete status.syncWindows;
    delete status.accountSync;
  }
  return status;
}

async function fakeCollector(_host: string, request: NativeRequest) {
  nativeCalls.push(request);
  const override = nativeOverrides[request.method];
  if (override) return override;
  switch (request.method) {
    case 'candidates.list':
      return { ok: true, result: { cards: [], status: collectorStatus() } };
    case 'collection.status':
    case 'collection.configure':
      return { ok: true, result: collectorStatus() };
    case 'turns.append': {
      const messages = request.params.messages!;
      const newTurns = new Set(messages.map((m) => m.turnId)).size;
      return {
        ok: true,
        result: { newMessages: messages.length, queued: true, intakeIssues: [], outsideWindow: outsideWindowPerAppend, skippedTurns: 0, newTurns },
      };
    }
    default:
      return { ok: true, result: {} };
  }
}

// ── 가짜 chatgpt.com 탭 ──
interface FakeTab {
  id: number;
  active: boolean;
  url: string;
  discarded?: boolean;
}
let tabs: FakeTab[] = [];
const tabCalls: { tabId: number; request: TabSyncRequest }[] = [];
let tabAccount = ACCOUNT;
let projectPages: SyncConversationRef[][] = [];
let conversationTurns: Record<string, number> = {};
// 응답을 바꾼다. 'silent' = 답하지 않음, 'closed' = 채널 닫힘. 열쇠: sync.session, page:<cursor|first>, conv:<id>
type TabReply = object | 'silent' | 'closed' | (() => Promise<object>);
let tabOverrides: Record<string, TabReply> = {};
let silentTabs = new Set<number>();

const ref = (id: string, minutes: number, isArchived = false): SyncConversationRef => ({
  id,
  updateTime: at(minutes),
  isArchived,
  gizmoId: PROJECT.gizmoId,
});

/** 대화 하나의 동기화 메시지: 턴마다 질문 + 답변, turnId 는 질문 id */
function syncMessages(conversationId: string, turns: number): CollectedMessage[] {
  return Array.from({ length: turns }, (_, i) => {
    const turnId = `${conversationId}-u${i}`;
    const createdAt = at(-30 + i);
    const base = { site: 'chatgpt' as const, conversationId, origin: 'sync' as const, createdAt, collectedAt: createdAt, turnId };
    return [
      { ...base, id: `chatgpt:${turnId}`, role: 'user' as const, text: `질문 ${i}` },
      { ...base, id: `chatgpt:${conversationId}-a${i}`, role: 'assistant' as const, text: `답변 ${i}` },
    ];
  }).flat();
}

const okTab = <T>(data: T) => ({ ok: true, account: tabAccount, data });
const tabError = (error: string, extra: object = {}) => ({ ok: false, error, ...extra });

function defaultReply(request: TabSyncRequest): object {
  switch (request.type) {
    case 'sync.session':
      return okTab(null);
    case 'sync.projects':
      return okTab([PROJECT]);
    case 'sync.projectPage': {
      const index = request.cursor ? Number(request.cursor.slice(1)) : 0;
      return okTab({ items: projectPages[index] ?? [], nextCursor: index + 1 < projectPages.length ? `p${index + 1}` : null });
    }
    case 'sync.conversation':
      return okTab({ messages: syncMessages(request.id, conversationTurns[request.id] ?? 1), inProgress: false, skippedNoTime: 0 });
  }
}

function fakeTabMessage(tabId: number, request: TabSyncRequest): Promise<unknown> {
  tabCalls.push({ tabId, request });
  if (silentTabs.has(tabId)) return new Promise(() => {});
  const key =
    request.type === 'sync.conversation' ? `conv:${request.id}` : request.type === 'sync.projectPage' ? `page:${request.cursor ?? 'first'}` : request.type;
  const override = tabOverrides[key];
  if (override === 'silent') return new Promise(() => {});
  if (override === 'closed') return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
  if (typeof override === 'function') return override();
  return Promise.resolve(override ?? defaultReply(request));
}

// ── background 메시지 ──
type MessageListener = (message: unknown, sender: object, sendResponse: (response: unknown) => void) => unknown;
let onMessage: MessageListener = () => undefined;
const send = (message: unknown, sender: object) => new Promise((resolve) => expect(onMessage(message, sender, resolve)).toBe(true));
const fromPage = (url: string) => ({ url, tab: { id: 1 }, id: fakeBrowser.runtime.id });
const fromPopup = () => ({ id: fakeBrowser.runtime.id, url: `chrome-extension://${fakeBrowser.runtime.id}/popup.html` });
const chatPage = fromPage('https://chatgpt.com/c/c1');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const calledMethods = () => nativeCalls.map((c) => c.method);
const appendCalls = () => nativeCalls.filter((c) => c.method === 'turns.append');
const detailIds = () => tabCalls.filter((c) => c.request.type === 'sync.conversation').map((c) => (c.request as { id: string }).id);
const pageCalls = () => tabCalls.filter((c) => c.request.type === 'sync.projectPage');
const state = () => syncStateItem.getValue();
let sleeps: number[] = [];

/** 켜져 있는 상태를 바로 저장한다 (syncSet 을 거치지 않는 패스 시험용) */
const enabled = (patch: Partial<SyncState> = {}) =>
  syncStateItem.setValue({ ...SYNC_DEFAULTS, enabled: true, project: PROJECT, account: ACCOUNT, enabledAt: at(-60), mode: 'idle', ...patch });

beforeEach(async () => {
  fakeBrowser.reset();
  resetLeaderTabMemory();
  clock = Date.now();
  nativeCalls.length = 0;
  tabCalls.length = 0;
  statusPatch = {};
  oldCollector = false;
  outsideWindowPerAppend = 0;
  nativeOverrides = {};
  tabs = [{ id: 11, active: true, url: 'https://chatgpt.com/g/g-p-team/project' }];
  tabAccount = ACCOUNT;
  projectPages = [[ref('c1', -10)]];
  conversationTurns = {};
  tabOverrides = {};
  silentTabs = new Set();
  sleeps = [];
  vi.spyOn(syncTiming, 'now').mockImplementation(() => clock);
  vi.spyOn(syncTiming, 'random').mockReturnValue(0.5);
  vi.spyOn(syncTiming, 'sleep').mockImplementation(async (ms) => void sleeps.push(ms));
  vi.spyOn(fakeBrowser.runtime, 'sendNativeMessage').mockImplementation(fakeCollector as never);
  vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue(undefined);
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => tabs) as never);
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(fakeTabMessage as never);
  vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener').mockImplementation((listener) => void (onMessage = listener as never));
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation(() => {});
  background.main();
  await settle(); // 시작할 때 하는 상태 새로 고침이 끝나게 둔다
  nativeCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('커서', () => {
  beforeEach(() => enabled());

  it('첫 패스는 창 시작부터 보고, 끝나면 커서를 패스 시작 − 10분으로 올린다', async () => {
    projectPages = [[ref('c1', -10), ref('c2', -100)], [ref('c3', -110), ref('c-before', -130)], [ref('c-never', -200)]];
    expect(await runSyncPass()).toEqual({ sync: 'ran', newTurns: 3 });
    expect(detailIds()).toEqual(['c1', 'c2', 'c3']); // 창 시작(-120분)보다 오래된 항목에서 멈춘다
    expect(pageCalls()).toHaveLength(2); // 그 쪽까지만 읽고 다음 쪽은 읽지 않는다
    expect(await state()).toMatchObject({ mode: 'idle', cursor: at(-10), pending: [], pendingPassStartedAt: null, lastError: null });
  });

  it('다음 패스는 실효 커서 max(창 시작, 커서) 이후에 바뀐 대화만 본다', async () => {
    await enabled({ cursor: at(-15) });
    projectPages = [[ref('c-new', -5), ref('c-old', -20), ref('c-older', -30)]];
    await runSyncPass();
    expect(detailIds()).toEqual(['c-new']);
  });

  it('커서가 창 시작보다 오래됐으면 창 시작을 쓴다', async () => {
    await enabled({ cursor: at(-600) });
    projectPages = [[ref('c-in', -100), ref('c-out', -125)]];
    await runSyncPass();
    expect(detailIds()).toEqual(['c-in']);
  });

  it('생성 중인 답변이 있으면 그 대화를 남김으로 빼고 커서를 올리지 않는다', async () => {
    await enabled({ cursor: at(-60) });
    projectPages = [[ref('c1', -5), ref('c2', -6)]];
    tabOverrides['conv:c1'] = okTab({ messages: syncMessages('c1', 1), inProgress: true, skippedNoTime: 0 });
    expect(await runSyncPass()).toMatchObject({ sync: 'ran' });
    expect(appendCalls()).toHaveLength(2); // 완료된 턴은 보낸다
    expect(await state()).toMatchObject({ cursor: at(-60), pending: [], pendingPassStartedAt: null });
  });

  it('남김이 앞 패스에 있었으면 다음 패스가 pending 을 비워도 커서를 올리지 않는다', async () => {
    await enabled({ cursor: at(-60) });
    projectPages = [Array.from({ length: 22 }, (_, i) => ref(`c${i}`, -1 - i))];
    tabOverrides['conv:c0'] = tabError('network');
    await runSyncPass();
    expect((await state()).pending).toEqual(['c20', 'c21']);
    expect(await syncLeftoverItem.getValue()).toBe(true);
    await runSyncPass();
    expect(await state()).toMatchObject({ pending: [], cursor: at(-60) });
    // 그다음 패스는 같은 범위를 다시 읽는다
    tabCalls.length = 0;
    delete tabOverrides['conv:c0'];
    await runSyncPass();
    expect(pageCalls()).toHaveLength(1);
    expect(detailIds()[0]).toBe('c0');
  });

  it('수집기가 거절하면 그 대화를 pending 에 두고 커서를 올리지 않는다', async () => {
    await enabled({ cursor: at(-60) });
    nativeOverrides['turns.append'] = { ok: false, error: '수집이 활성화되지 않았습니다.' };
    expect(await runSyncPass()).toEqual({ sync: 'failed', newTurns: 0 });
    expect(await state()).toMatchObject({ pending: ['c1'], cursor: at(-60), mode: 'idle', lastError: { code: 'collector' } });
  });
});

describe('대화 상세', () => {
  beforeEach(() => enabled());

  it('한 패스는 상세 최대 20건, 남은 대상은 pending 으로 다음 패스에서 이어 간다', async () => {
    projectPages = [Array.from({ length: 25 }, (_, i) => ref(`c${i}`, -1 - i))];
    await runSyncPass();
    expect(detailIds()).toHaveLength(20);
    const first = await state();
    expect(first.pending).toEqual(['c20', 'c21', 'c22', 'c23', 'c24']);
    expect(first.pendingPassStartedAt).toBe(at(0));
    expect(first.cursor).toBeNull();

    tabCalls.length = 0;
    clock += 5 * MIN;
    await runSyncPass();
    expect(pageCalls()).toHaveLength(0); // pending 이 남아 있으면 목록을 다시 읽지 않는다
    expect(detailIds()).toEqual(['c20', 'c21', 'c22', 'c23', 'c24']);
    expect(await state()).toMatchObject({ pending: [], cursor: at(-15) }); // 첫 패스 시작 − 10분
  });

  it('상세 요청 사이에 1~2초를 무작위로 둔다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2), ref('c3', -3)]];
    vi.mocked(syncTiming.random).mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    await runSyncPass();
    expect(sleeps).toHaveLength(2); // 첫 요청 앞에는 두지 않는다
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBeGreaterThan(1990);
    expect(sleeps[1]).toBeLessThanOrEqual(2000);
  });

  it('보관한 대화는 대상에서 빼고, 같은 id 는 한 번만 넣는다', async () => {
    projectPages = [[ref('c1', -1), ref('c-archived', -2, true), ref('c2', -3)], [ref('c1', -4), ref('c3', -5)]];
    await runSyncPass();
    expect(detailIds()).toEqual(['c1', 'c2', 'c3']);
  });

  it('지운 대화(not_found)는 건너뛰고 남김으로 세지 않는다', async () => {
    projectPages = [[ref('c-gone', -1), ref('c2', -2)]];
    tabOverrides['conv:c-gone'] = tabError('not_found');
    expect(await runSyncPass()).toEqual({ sync: 'ran', newTurns: 1 });
    expect(await state()).toMatchObject({ pending: [], cursor: at(-10) });
  });

  it('받은 메시지를 턴을 가르지 않고 200개 이하로 나눠 flush 없이 보낸다', async () => {
    projectPages = [[ref('c1', -1)]];
    conversationTurns.c1 = 150; // 메시지 300개
    outsideWindowPerAppend = 2;
    expect(await runSyncPass()).toEqual({ sync: 'ran', newTurns: 150 });
    expect(appendCalls().map((c) => c.params.messages!.length)).toEqual([200, 100]);
    expect(appendCalls().every((c) => !('flush' in c.params))).toBe(true);
    expect((await state()).stats).toMatchObject({ passes: 1, conversationsChecked: 1, turnsSent: 150, outsideWindow: 4 });
  });

  it('턴 경계가 200 에 맞지 않으면 그 턴을 다음 묶음으로 넘긴다', () => {
    const [question, answer] = syncMessages('d', 1);
    const longTurn = [question!, answer!, { ...answer!, id: 'chatgpt:d-a0-2', text: '이어진 답변' }]; // 답변 노드가 둘인 턴
    const messages = [...syncMessages('c', 99), ...longTurn]; // 198 + 3
    const chunks = appendChunks(messages);
    expect(chunks.map((c) => c.length)).toEqual([198, 3]);
    expect(chunks.flat()).toEqual(messages);
  });

  it('한 턴이 200개보다 길 때만 그 턴을 자른다', () => {
    const [question, answer] = syncMessages('e', 1);
    const huge = [question!, ...Array.from({ length: 449 }, (_, i) => ({ ...answer!, id: `chatgpt:e-a${i}` }))];
    expect(appendChunks(huge).map((c) => c.length)).toEqual([200, 200, 50]);
  });

  it('탭이 동기화 창을 그대로 받는다', async () => {
    await runSyncPass();
    const detail = tabCalls.find((c) => c.request.type === 'sync.conversation')!.request;
    expect(detail).toEqual({ type: 'sync.conversation', id: 'c1', windows: collectorStatus().syncWindows });
  });

  it('동기화 창이 비었으면 목록을 읽지 않고 끝낸다', async () => {
    statusPatch = { syncWindows: [] };
    expect(await runSyncPass()).toEqual({ sync: 'ran', newTurns: 0 });
    expect(pageCalls()).toHaveLength(0);
  });
});

describe('쉼', () => {
  beforeEach(() => enabled());

  it('429 에 Retry-After 가 있으면 그만큼 쉬고, 쉬는 동안 패스를 건너뛴다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2)]];
    tabOverrides['conv:c2'] = tabError('rate_limited', { retryAfterSec: 90 });
    expect(await runSyncPass()).toEqual({ sync: 'resting', newTurns: 1 });
    expect(await state()).toMatchObject({ mode: 'rest', restReason: 'rate_limited', restUntil: at(1.5), pending: ['c2'], cursor: null });

    tabCalls.length = 0;
    clock += MIN;
    expect(await runSyncPass()).toEqual({ sync: 'resting', newTurns: 0 });
    expect(tabCalls).toHaveLength(0);

    clock += MIN; // 쉼이 끝나면 pending 부터 이어 간다
    delete tabOverrides['conv:c2'];
    expect(await runSyncPass()).toEqual({ sync: 'ran', newTurns: 1 });
    expect(await state()).toMatchObject({ mode: 'idle', restUntil: null, restReason: null, pending: [] });
  });

  it('429 에 Retry-After 가 없으면 30분 쉰다 (목록 요청에서도)', async () => {
    tabOverrides['page:first'] = tabError('rate_limited');
    expect(await runSyncPass()).toMatchObject({ sync: 'resting' });
    expect(await state()).toMatchObject({ mode: 'rest', restUntil: at(30), pending: [], pendingPassStartedAt: null });
  });

  it('403 은 120분 쉰다', async () => {
    tabOverrides['conv:c1'] = tabError('forbidden');
    expect(await runSyncPass()).toMatchObject({ sync: 'resting' });
    expect(await state()).toMatchObject({ mode: 'rest', restReason: 'forbidden', restUntil: at(120), lastError: { code: 'forbidden' } });
  });
});

describe('멈춤', () => {
  beforeEach(() => enabled());

  it('수집이 일시정지됐거나 끝났으면 탭에 묻지 않고 멈춘다', async () => {
    await enabled();
    statusPatch = { autoCollect: false };
    expect(await runSyncPass()).toMatchObject({ sync: 'failed' });
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'collection_paused' });
    expect(tabCalls).toHaveLength(0);
  });

  it('응답하는 chatgpt.com 탭이 없으면 no_tab', async () => {
    await enabled();
    tabs = [];
    expect(await runSyncPass()).toMatchObject({ sync: 'no-tab' });
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'no_tab' });
  });

  it('탭이 있어도 콘텐츠 스크립트가 답하지 않으면 no_tab (확장을 다시 불러온 뒤 남은 탭)', async () => {
    await enabled();
    tabOverrides['sync.session'] = 'closed';
    expect(await runSyncPass()).toMatchObject({ sync: 'no-tab' });
  });

  it('로그아웃이면 logged_out', async () => {
    await enabled();
    tabOverrides['sync.session'] = tabError('logged_out');
    await runSyncPass();
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'logged_out' });
  });

  it('탭 계정이 켤 때 묶은 계정과 다르면 account_mismatch', async () => {
    await enabled();
    tabAccount = OTHER_ACCOUNT;
    await runSyncPass();
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'account_mismatch' });
    expect(appendCalls()).toHaveLength(0);
  });

  it('응답 모양이 바뀌면 shape_changed, 그 대화는 pending 에 남는다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2)]];
    tabOverrides['conv:c2'] = tabError('shape_changed');
    await runSyncPass();
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'shape_changed', pending: ['c2'] });
  });

  it('멈춘 뒤 다음 알람은 다시 확인하고, 고쳐졌으면 돈다', async () => {
    await enabled();
    tabs = [];
    await runSyncPass();
    tabs = [{ id: 12, active: false, url: 'https://chatgpt.com/' }];
    expect(await runSyncPass()).toMatchObject({ sync: 'ran' });
    expect(await state()).toMatchObject({ mode: 'idle', stopReason: null });
  });
});

describe('대표 탭', () => {
  beforeEach(() => enabled());

  it('활성 탭을 먼저 쓰고, 답하지 않으면 다른 탭으로 한 패스를 돈다', async () => {
    tabs = [
      { id: 21, active: false, url: 'https://chatgpt.com/' },
      { id: 22, active: true, url: 'https://chatgpt.com/' },
      { id: 23, active: false, url: 'https://chatgpt.com/', discarded: true },
    ];
    silentTabs.add(22);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pass = runSyncPass();
    await vi.advanceTimersByTimeAsync(20_000); // 활성 탭의 20초 시간 제한
    expect(await pass).toMatchObject({ sync: 'ran' });
    expect(tabCalls[0]!.tabId).toBe(22);
    expect(new Set(tabCalls.slice(1).map((c) => c.tabId))).toEqual(new Set([21]));
  });

  it('요청마다 20초 시간 제한을 두고, 넘으면 응답 없음으로 본다', async () => {
    tabOverrides['sync.session'] = 'silent';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let result: unknown = null;
    void runSyncPass().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(result).toMatchObject({ sync: 'no-tab' }));
  });

  it('패스 도중 탭이 끊기면 그 대화는 남김, 남은 대화는 다음 패스로 미룬다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2), ref('c3', -3)]];
    tabOverrides['conv:c2'] = 'closed';
    expect(await runSyncPass()).toMatchObject({ sync: 'failed' });
    expect(detailIds()).toEqual(['c1', 'c2']);
    expect(await state()).toMatchObject({ pending: ['c3'], lastError: { code: 'network' } });
    expect(await syncLeftoverItem.getValue()).toBe(true);
  });
});

describe('한 번에 한 패스', () => {
  beforeEach(() => enabled());

  it('패스가 도는 동안 다시 부르면 기다리지 않고 busy', async () => {
    let answerSession: (value: object) => void = () => {};
    tabOverrides['sync.session'] = () => new Promise((resolve) => (answerSession = resolve));
    const first = runSyncPass();
    await vi.waitFor(() => expect(tabCalls).toHaveLength(1));
    expect(await runSyncPass()).toEqual({ sync: 'busy', newTurns: 0 });
    expect((await state()).mode).toBe('running');
    answerSession(okTab(null));
    expect(await first).toMatchObject({ sync: 'ran' });
    delete tabOverrides['sync.session'];
    expect(await runSyncPass()).toMatchObject({ sync: 'ran' }); // 끝나면 다시 돌 수 있다
  });

  it('패스 도중 끄면 패스는 결과를 쓰지 않고 멈춘다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2)]];
    let answerC1: (value: object) => void = () => {};
    tabOverrides['conv:c1'] = () => new Promise((resolve) => (answerC1 = resolve));
    const pass = runSyncPass();
    await vi.waitFor(() => expect(detailIds()).toEqual(['c1']));
    expect(await send({ type: 'syncSet', enabled: false }, fromPopup())).toMatchObject({ ok: true });
    answerC1(okTab({ messages: syncMessages('c1', 1), inProgress: false, skippedNoTime: 0 }));
    expect(await pass).toMatchObject({ sync: 'off' });
    expect(detailIds()).toEqual(['c1']);
    expect(appendCalls()).toHaveLength(0); // 끈 뒤에 받은 대화는 보내지 않는다
    expect(await state()).toMatchObject({ enabled: false, mode: 'off' });
  });
});

describe('syncNow (싱크 맞추기)', () => {
  const syncNow = async (sender: object = fromPopup()) =>
    (await send({ type: 'syncNow', params: { reason: 'button' } }, sender)) as { ok: true; result: SyncNowResult };

  it('정상으로 돌면 ran 과 새 턴 수, 수집 중이면 flush 를 부른다', async () => {
    await enabled();
    const response = await syncNow();
    expect(response).toEqual({ ok: true, result: { sync: 'ran', newTurns: 1, flushed: true } });
    expect(calledMethods()).toContain('collection.flush');
    expect(calledMethods().indexOf('collection.flush')).toBeGreaterThan(calledMethods().indexOf('turns.append'));
  });

  it('꺼져 있으면 off, 그래도 flush 는 부른다', async () => {
    expect((await syncNow()).result).toEqual({ sync: 'off', newTurns: 0, flushed: true });
    expect(tabCalls).toHaveLength(0);
  });

  it('쉬는 중이면 resting', async () => {
    await enabled({ mode: 'rest', restUntil: at(10), restReason: 'rate_limited' });
    expect((await syncNow()).result).toMatchObject({ sync: 'resting', flushed: true });
  });

  it('탭이 없으면 no-tab', async () => {
    await enabled();
    tabs = [];
    expect((await syncNow()).result).toMatchObject({ sync: 'no-tab', flushed: true });
  });

  it('이미 도는 중이면 busy, 끝날 때까지 기다리지 않고 flush 한다', async () => {
    await enabled();
    let answerSession: (value: object) => void = () => {};
    tabOverrides['sync.session'] = () => new Promise((resolve) => (answerSession = resolve));
    const running = runSyncPass();
    await vi.waitFor(() => expect(tabCalls).toHaveLength(1));
    expect((await syncNow()).result).toEqual({ sync: 'busy', newTurns: 0, flushed: true });
    answerSession(tabError('logged_out'));
    await running; // 다음 시험에 도는 패스를 남기지 않는다
  });

  it('그 밖의 멈춤은 failed', async () => {
    await enabled();
    tabOverrides['sync.session'] = tabError('logged_out');
    expect((await syncNow()).result).toMatchObject({ sync: 'failed', flushed: true });
  });

  it('수집 중이 아니면 flush 하지 않고 sendBlockedReason 문구를 돌려준다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), autoCollect: false });
    expect((await syncNow()).result).toEqual({
      sync: 'off',
      newTurns: 0,
      flushed: false,
      blockedReason: '수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요',
    });
    expect(calledMethods()).not.toContain('collection.flush');
  });

  it('채팅 화면에서도 받는다', async () => {
    expect(await syncNow(chatPage)).toMatchObject({ ok: true, result: { sync: 'off', flushed: true } });
  });

  it('웹의 rpc ext.syncNow 는 수집기로 넘기지 않고 같은 함수로 처리한다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    await enabled();
    const response = await send({ type: 'rpc', method: EXT_SYNC_NOW, params: { reason: 'review-open' } }, fromPage('http://localhost:3000/review'));
    expect(response).toEqual({ ok: true, result: { sync: 'ran', newTurns: 1, flushed: true } });
    expect(calledMethods()).not.toContain(EXT_SYNC_NOW);
  });

  it('웹의 flush 실패는 웹에만 돌려준다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    nativeOverrides['collection.flush'] = { ok: false, error: '수집이 활성화되지 않았습니다.' };
    const response = await send({ type: 'rpc', method: EXT_SYNC_NOW, params: { reason: 'button' } }, fromPage('http://localhost:3000/review'));
    expect(response).toEqual({ ok: false, error: '수집이 활성화되지 않았습니다.' });
  });

  it('믿지 않는 웹 출처는 거절한다', async () => {
    const response = await send({ type: 'syncNow', params: { reason: 'button' } }, fromPage('https://example.com/'));
    expect(response).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
  });
});

describe('syncSet (프로젝트만 수집 켬·끔)', () => {
  const syncSet = (enabledFlag: boolean, project?: object, sender: object = fromPopup()) =>
    send({ type: 'syncSet', enabled: enabledFlag, project }, sender) as Promise<{ ok: boolean; result?: SyncState; error?: string }>;

  it('켜면 계정을 수집기에 묶고, 상태를 저장하고, 알람을 만들고, 패스를 한 번 돈다', async () => {
    const response = await syncSet(true, PROJECT);
    expect(response.ok).toBe(true);
    expect(nativeCalls.find((c) => c.method === 'collection.configure')!.params).toEqual({ accountSync: { enabled: true, account: ACCOUNT } });
    expect(response.result).toMatchObject({ enabled: true, project: PROJECT, account: ACCOUNT, enabledAt: at(0), mode: 'idle', cursor: at(-10) });
    expect(detailIds()).toEqual(['c1']);
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toMatchObject({ periodInMinutes: 5 });
  });

  it('응답하는 탭이 없으면 탭을 열라고 한다', async () => {
    tabs = [];
    expect(await syncSet(true, PROJECT)).toEqual({ ok: false, error: SYNC_SET_ERRORS.noTab });
    expect(SYNC_SET_ERRORS.noTab).toBe('chatgpt.com 탭을 하나 열어 두세요');
  });

  it('로그아웃이면 로그인하라고 한다', async () => {
    tabOverrides['sync.session'] = tabError('logged_out');
    expect(await syncSet(true, PROJECT)).toEqual({ ok: false, error: 'ChatGPT에 로그인하세요' });
  });

  it('collection.status 에 accountSync 키가 없으면 옛 수집기로 보고 거절한다', async () => {
    oldCollector = true;
    expect(await syncSet(true, PROJECT)).toEqual({ ok: false, error: '수집기를 새 버전으로 바꾸면 쓸 수 있어요' });
    expect(calledMethods()).not.toContain('collection.configure');
  });

  it('accountSync 가 null 이어도(한 번도 켠 적 없음) 새 수집기다', async () => {
    statusPatch = { accountSync: null, syncWindows: [] };
    expect(await syncSet(true, PROJECT)).toMatchObject({ ok: true });
  });

  it('수집기 오류는 수집기가 준 문구 그대로', async () => {
    nativeOverrides['collection.configure'] = { ok: false, error: '동기화 계정 오류' };
    expect(await syncSet(true, PROJECT)).toEqual({ ok: false, error: '동기화 계정 오류' });
    expect((await state()).enabled).toBe(false);
  });

  it('프로젝트를 고르지 않으면 거절한다', async () => {
    expect(await syncSet(true)).toEqual({ ok: false, error: '프로젝트를 고르세요' });
    expect(tabCalls).toHaveLength(0);
  });

  it('끄면 수집기에 알리고, mode=off 로 두고, 알람을 지운다', async () => {
    await syncSet(true, PROJECT);
    nativeCalls.length = 0;
    const response = await syncSet(false);
    expect(response).toMatchObject({ ok: true, result: { enabled: false, mode: 'off' } });
    expect(nativeCalls.find((c) => c.method === 'collection.configure')!.params).toEqual({ accountSync: { enabled: false } });
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toBeUndefined();
  });

  it('다시 켜면 커서·pending 을 새로 시작한다', async () => {
    await enabled({ cursor: at(-5), pending: ['old'], pendingPassStartedAt: at(-20) });
    projectPages = [[ref('c-fresh', -50)]];
    await syncSet(true, PROJECT);
    expect(detailIds()).toEqual(['c-fresh']);
  });

  it('채팅 화면과 웹에서 온 syncSet 은 거절한다', async () => {
    expect(await syncSet(true, PROJECT, chatPage)).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    expect(await syncSet(true, PROJECT, fromPage('http://localhost:3000/review'))).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    expect((await state()).enabled).toBe(false);
  });
});

describe('알람과 시작', () => {
  it('refresh 알람은 상태만 새로 고치고 패스를 돌지 않는다', async () => {
    await enabled();
    await fakeBrowser.alarms.onAlarm.trigger({ name: 'refresh', scheduledTime: clock, persistAcrossSessions: false });
    await settle();
    expect(calledMethods()).toEqual(['candidates.list']);
    expect(tabCalls).toHaveLength(0);
  });

  it('chatgpt-sync 알람은 패스를 돌고 상태 새로 고침은 하지 않는다', async () => {
    await enabled();
    await fakeBrowser.alarms.onAlarm.trigger({ name: SYNC_ALARM, scheduledTime: clock, persistAcrossSessions: false });
    await vi.waitFor(async () => expect((await state()).lastPassFinishedAt).not.toBeNull());
    expect(calledMethods()).toContain('collection.status');
    expect(calledMethods()).not.toContain('candidates.list');
  });

  it('서비스 워커가 시작할 때 켜져 있는데 알람이 없으면 다시 만든다', async () => {
    await enabled();
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toBeUndefined();
    background.main();
    await vi.waitFor(async () => expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toMatchObject({ periodInMinutes: 5 }));
  });

  it('꺼져 있으면 시작할 때 알람을 만들지 않는다', async () => {
    background.main();
    await settle();
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toBeUndefined();
  });

  it('브라우저를 시작하면 패스를 한 번 돈다', async () => {
    await enabled();
    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(async () => expect((await state()).stats.passes).toBe(1));
  });
});
