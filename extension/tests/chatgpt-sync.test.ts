// 프로젝트만 수집 동기화(패스·스케줄러, docs/sync-contract.md 5장). background 를 가짜 browser 위에서 띄우고,
// 로컬 수집기(native host)와 chatgpt.com 탭의 콘텐츠 스크립트(sync.* 응답)는 모두 가짜로 둔다
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { EXT_SYNC_NOW, type AccountSyncState, type ExtStatus, type SyncNowResult } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';
import background from '@/entrypoints/background';
import { resetLeaderTabMemory } from '@/lib/chatgpt-sync/leader-tab';
import { appendChunks, estimateJsonBytes, runSyncPass, syncLeftoverItem, syncTiming } from '@/lib/chatgpt-sync/pass';
import { SYNC_OFF_PENDING_ERROR, SYNC_SET_ERRORS } from '@/lib/chatgpt-sync/scheduler';
import { SYNC_ALARM, SYNC_APPEND_MAX_BYTES, SYNC_DEFAULTS, syncStateItem, type SyncState } from '@/lib/chatgpt-sync/state';
import type { SyncConversationData, SyncConversationRef, TabSyncRequest } from '@/lib/messages';
import { settingsItem } from '@/lib/settings';
import { LOCAL_WEB_URL } from '@/lib/web-url';

const MIN = 60_000;
const ACCOUNT = 'a'.repeat(64);
const OTHER_ACCOUNT = 'b'.repeat(64);
const PROJECT = { gizmoId: `g-p-${'a1'.repeat(16)}`, name: '해커톤' }; // 실제 꼴: g-p-<32자리 16진수>
const OTHER_PROJECT_ID = `g-p-${'b2'.repeat(16)}`;

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
// 수집기의 accountSync. collection.configure 가 바꾼다 (켬 = 켬 시각을 새로 찍음, 끔 = 계정만 남김)
let collectorSync: AccountSyncState | null = null;

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
    syncWindows: collectorSync?.enabled ? [{ start: at(-120), end: at(24 * 60) }] : [],
    accountSync: collectorSync,
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
    case 'collection.configure': {
      const patch = request.params.accountSync as { enabled: boolean; account?: string } | undefined;
      if (patch?.enabled) collectorSync = { enabled: true, account: patch.account!, since: at(0) };
      else if (patch) collectorSync = collectorSync && { ...collectorSync, enabled: false, since: null };
      return { ok: true, result: collectorStatus() };
    }
    case 'collection.status':
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

const ref = (id: string, minutes: number, isArchived = false, isTemporary = false): SyncConversationRef => ({
  id,
  updateTime: at(minutes),
  isArchived,
  isTemporary,
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
const conversationData = (id: string, turns = 1, inProgressAt: string | null = null): SyncConversationData => ({
  messages: syncMessages(id, turns),
  inProgress: inProgressAt !== null,
  inProgressAt,
  skippedNoTime: 0,
});
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
      return okTab(conversationData(request.id, conversationTurns[request.id] ?? 1));
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
// fakeBrowser 에 contextMenus.onClicked 가 없어서 등록된 처리기를 직접 받아 둔다
let menuClicked: (info: object, tab: object) => void = () => {};

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
  collectorSync = { enabled: true, account: ACCOUNT, since: at(-120) };
  tabs = [{ id: 11, active: true, url: `https://chatgpt.com/g/${PROJECT.gizmoId}-hackathon/project` }];
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
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation((listener) => void (menuClicked = listener as never));
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
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 3 });
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
    tabOverrides['conv:c1'] = okTab(conversationData('c1', 1, at(-2)));
    expect(await runSyncPass()).toMatchObject({ sync: 'ran' });
    expect(appendCalls()).toHaveLength(2); // 완료된 턴은 보낸다
    expect(await state()).toMatchObject({ cursor: at(-60), pending: [], pendingPassStartedAt: null });
  });

  it('미완료 턴이 10분보다 오래됐으면(멈춘 답) 남김으로 보지 않고 커서를 올린다', async () => {
    await enabled({ cursor: at(-60) });
    tabOverrides['conv:c1'] = okTab(conversationData('c1', 1, at(-11)));
    await runSyncPass();
    expect(await state()).toMatchObject({ cursor: at(-10) });
  });

  it('미완료 턴의 시각을 모르면(inProgressAt 없음) 남김으로 둔다', async () => {
    await enabled({ cursor: at(-60) });
    tabOverrides['conv:c1'] = okTab({ ...conversationData('c1'), inProgress: true, inProgressAt: null });
    await runSyncPass();
    expect(await state()).toMatchObject({ cursor: at(-60) });
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

  it('수집기가 그 대화의 turns.append 를 거절하면 대화별 실패로 세고 남김으로 둔다, 남은 대화는 다음 패스에', async () => {
    await enabled({ cursor: at(-60) });
    projectPages = [[ref('c1', -1), ref('c2', -2)]];
    nativeOverrides['turns.append'] = { ok: false, error: '요청이 너무 큽니다.' };
    expect(await runSyncPass()).toMatchObject({ sync: 'failed', newTurns: 0 });
    expect(detailIds()).toEqual(['c1']);
    expect(await state()).toMatchObject({ pending: ['c2'], failures: { c1: 1 }, cursor: at(-60), mode: 'idle', lastError: { code: 'collector' } });
    expect(await syncLeftoverItem.getValue()).toBe(true);
  });

  it('수집기에 닿지 못하면 대화 탓으로 세지 않고 pending 에 둔다', async () => {
    await enabled({ cursor: at(-60) });
    vi.mocked(fakeBrowser.runtime.sendNativeMessage).mockImplementation((async (host: string, request: NativeRequest) => {
      if (request.method === 'turns.append') throw new Error('Native host has exited.');
      return fakeCollector(host, request);
    }) as never);
    expect(await runSyncPass()).toMatchObject({ sync: 'failed' });
    expect(await state()).toMatchObject({ pending: ['c1'], failures: {}, lastError: { code: 'collector' } });
  });
});

describe('대화별 실패', () => {
  beforeEach(() => enabled({ cursor: at(-60) }));

  it('대화 상세의 shape_changed 는 멈춤이 아니라 그 대화만 실패로 센다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2), ref('c3', -3)]];
    tabOverrides['conv:c2'] = tabError('shape_changed');
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 2 });
    expect(detailIds()).toEqual(['c1', 'c2', 'c3']);
    expect(await state()).toMatchObject({ mode: 'idle', stopReason: null, pending: [], failures: { c2: 1 }, cursor: at(-60) });
  });

  it('3번째 실패는 건너뜀: 커서를 붙잡지 않고 lastError·skippedConversations 에 남긴다', async () => {
    projectPages = [[ref('c-bad', -1), ref('c-ok', -2)]];
    tabOverrides['conv:c-bad'] = tabError('shape_changed');
    await runSyncPass();
    await runSyncPass();
    expect(await state()).toMatchObject({ failures: { 'c-bad': 2 }, cursor: at(-60) });
    clock += 5 * MIN;
    await runSyncPass();
    const third = await state();
    expect(third).toMatchObject({ failures: { 'c-bad': 3 }, cursor: at(-10), lastError: { code: 'shape_changed' } });
    expect(third.stats.skippedConversations).toBe(1);
    expect(detailIds().filter((id) => id === 'c-ok')).toHaveLength(3); // 다른 대화는 매 패스 받는다
  });

  it('건너뛴 대화가 나중에 바뀌어 목록에 다시 오르면 다시 시도하고, 받으면 실패 수를 지운다', async () => {
    await enabled({ cursor: at(-60), failures: { c1: 3 } });
    await runSyncPass();
    expect(await state()).toMatchObject({ failures: {} });
    expect(appendCalls()).toHaveLength(1);
  });

  it('건너뛴 대화 수는 누적하지 않고 패스마다 지금 failures 로 다시 센다', async () => {
    await enabled({ cursor: at(-60), failures: { c1: 3, gone: 4, flaky: 1 }, stats: { ...SYNC_DEFAULTS.stats, skippedConversations: 9 } });
    await runSyncPass(); // c1 을 받아 실패 수가 지워진다
    expect(await state()).toMatchObject({ failures: { gone: 4, flaky: 1 }, stats: { skippedConversations: 1 } });
  });

  it('켜면 건너뛴 대화 수를 0 으로 시작한다', async () => {
    await enabled({ failures: { c9: 3 }, stats: { ...SYNC_DEFAULTS.stats, passes: 7, skippedConversations: 1 } });
    collectorSync = { enabled: false, account: ACCOUNT, since: null };
    statusPatch = { syncWindows: [] }; // 켬 직후 패스가 아무것도 받지 않게
    await send({ type: 'syncSet', enabled: true, project: PROJECT }, fromPopup());
    expect((await state()).stats).toMatchObject({ passes: 8, skippedConversations: 0 });
  });

  it('network 실패도 대화별로 센다', async () => {
    tabOverrides['conv:c1'] = tabError('network');
    expect(await runSyncPass()).toMatchObject({ sync: 'ran' });
    expect(await state()).toMatchObject({ failures: { c1: 1 }, pending: [], cursor: at(-60), lastError: { code: 'network' } });
  });

  it('켜면 failures 를 비운다', async () => {
    await enabled({ failures: { c9: 2 } });
    await send({ type: 'syncSet', enabled: true, project: PROJECT }, fromPopup());
    expect((await state()).failures).toEqual({});
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

  it('임시 채팅은 대상에서 뺀다', async () => {
    projectPages = [[ref('c1', -1), ref('c-temp', -2, false, true)]];
    await runSyncPass();
    expect(detailIds()).toEqual(['c1']);
  });

  it('보관한 대화는 대상에서 빼고, 같은 id 는 한 번만 넣는다', async () => {
    projectPages = [[ref('c1', -1), ref('c-archived', -2, true), ref('c2', -3)], [ref('c1', -4), ref('c3', -5)]];
    await runSyncPass();
    expect(detailIds()).toEqual(['c1', 'c2', 'c3']);
  });

  it('지운 대화(not_found)는 건너뛰고 남김으로 세지 않는다', async () => {
    projectPages = [[ref('c-gone', -1), ref('c2', -2)]];
    tabOverrides['conv:c-gone'] = tabError('not_found');
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 1 });
    expect(await state()).toMatchObject({ pending: [], cursor: at(-10) });
  });

  it('받은 메시지를 턴을 가르지 않고 200개 이하로 나눠 flush 없이 보낸다', async () => {
    projectPages = [[ref('c1', -1)]];
    conversationTurns.c1 = 150; // 메시지 300개
    outsideWindowPerAppend = 2;
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 150 });
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

  it('추정 크기가 2.5 MiB 를 넘지 않게 나누고, ASCII 밖 글자는 6바이트로 센다', () => {
    expect(estimateJsonBytes('가a')).toBe(1 + 6 + 1 + 1); // "가a"
    const big = '가'.repeat(19_999) + '…'; // 탭이 자른 최대 본문 (약 120 KB)
    const messages = syncMessages('k', 30).map((m) => ({ ...m, text: big })); // 60개, 약 7 MB
    const chunks = appendChunks(messages);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(estimateJsonBytes({ messages: chunk })).toBeLessThanOrEqual(SYNC_APPEND_MAX_BYTES);
      expect(chunk.length % 2).toBe(0); // 질문·답 한 턴을 가르지 않는다
    }
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
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 0 });
    expect(pageCalls()).toHaveLength(0);
  });
});

describe('쉼', () => {
  beforeEach(() => enabled());

  it('429 에 Retry-After 가 있으면 그만큼 쉬고, 쉬는 동안 패스를 건너뛴다', async () => {
    projectPages = [[ref('c1', -1), ref('c2', -2)]];
    tabOverrides['conv:c2'] = tabError('rate_limited', { retryAfterSec: 90 });
    expect(await runSyncPass()).toMatchObject({ sync: 'resting', newTurns: 1 });
    expect(await state()).toMatchObject({ mode: 'rest', restReason: 'rate_limited', restUntil: at(1.5), pending: ['c2'], cursor: null });

    tabCalls.length = 0;
    clock += MIN;
    expect(await runSyncPass()).toMatchObject({ sync: 'resting', newTurns: 0 });
    expect(tabCalls).toHaveLength(0);

    clock += MIN; // 쉼이 끝나면 pending 부터 이어 간다
    delete tabOverrides['conv:c2'];
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 1 });
    expect(await state()).toMatchObject({ mode: 'idle', restUntil: null, restReason: null, pending: [] });
  });

  it('429 에 Retry-After 가 없으면 30분 쉰다 (목록 요청에서도)', async () => {
    tabOverrides['page:first'] = tabError('rate_limited');
    expect(await runSyncPass()).toMatchObject({ sync: 'resting' });
    expect(await state()).toMatchObject({ mode: 'rest', restUntil: at(30), pending: [], pendingPassStartedAt: null });
  });

  it.each([
    ['세션', 'sync.session'],
    ['목록', 'page:first'],
  ])('%s 403 은 120분 쉰다', async (_name, key) => {
    tabOverrides[key] = tabError('forbidden');
    expect(await runSyncPass()).toMatchObject({ sync: 'resting' });
    expect(await state()).toMatchObject({ mode: 'rest', restReason: 'forbidden', restUntil: at(120), lastError: { code: 'forbidden' } });
  });

  it('대화 상세 403 은 쉼이 아니라 대화별 실패다 (쉼이 끝없이 되풀이되지 않게)', async () => {
    await enabled({ cursor: at(-60) });
    projectPages = [[ref('c1', -1), ref('c2', -2)]];
    tabOverrides['conv:c1'] = tabError('forbidden');
    expect(await runSyncPass()).toMatchObject({ sync: 'ran', newTurns: 1 });
    expect(await state()).toMatchObject({ mode: 'idle', restUntil: null, failures: { c1: 1 }, pending: [], lastError: { code: 'forbidden' } });
    expect(detailIds()).toEqual(['c1', 'c2']);
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

  it('고른 프로젝트 목록이 not_found 이면 project_missing', async () => {
    tabOverrides['page:first'] = tabError('not_found');
    expect(await runSyncPass()).toMatchObject({ sync: 'failed' });
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'project_missing', pending: [] });
  });

  it('오류로 끝난 패스는 lastError 를 남기고 idle, 오류 없이 끝난 패스는 지운다', async () => {
    tabOverrides['sync.session'] = tabError('network');
    expect(await runSyncPass()).toMatchObject({ sync: 'failed' });
    expect(await state()).toMatchObject({ mode: 'idle', lastError: { code: 'network', at: at(0) } });
    delete tabOverrides['sync.session'];
    expect(await runSyncPass()).toMatchObject({ sync: 'ran' });
    expect((await state()).lastError).toBeNull();
  });

  it('세션 응답 모양이 바뀌면 shape_changed', async () => {
    tabOverrides['sync.session'] = tabError('shape_changed');
    await runSyncPass();
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'shape_changed' });
  });

  it('목록 응답 모양이 바뀌면 shape_changed, 모은 대상은 버린다', async () => {
    projectPages = [[ref('c1', -1)], [ref('c2', -2)]];
    tabOverrides['page:p1'] = tabError('shape_changed');
    await runSyncPass();
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'shape_changed', pending: [] });
    expect(detailIds()).toEqual([]);
  });

  it.each([
    ['꺼짐', { enabled: false, account: ACCOUNT, since: null }],
    ['없음(상태 폴더를 새로 만듦)', null],
    ['다른 계정', { enabled: true, account: OTHER_ACCOUNT, since: null }],
  ])('수집기 accountSync 가 %s 이면 탭에 묻지 않고 collector_off', async (_name, accountSync) => {
    statusPatch = { accountSync, syncWindows: [] };
    expect(await runSyncPass()).toMatchObject({ sync: 'failed' });
    expect(await state()).toMatchObject({ mode: 'stopped', stopReason: 'collector_off' });
    expect(tabCalls).toHaveLength(0);
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
    expect(await state()).toMatchObject({ pending: ['c3'], failures: { c2: 1 }, lastError: { code: 'network' } });
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
    expect(await runSyncPass()).toMatchObject({ sync: 'busy', newTurns: 0 });
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
    answerC1(okTab(conversationData('c1')));
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

  it('패스를 돌지 않았으면 collection.status 를 새로 읽어 판단한다: 수집 중이 아니면 flush 하지 않고 sendBlockedReason 문구', async () => {
    statusPatch = { autoCollect: false }; // 캐시된 설정은 아직 수집 중
    expect((await syncNow()).result).toEqual({
      sync: 'off',
      newTurns: 0,
      flushed: false,
      blockedReason: '수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요',
    });
    expect(calledMethods()).toEqual(['collection.status']);
  });

  it('이번 패스가 읽은 상태를 그대로 쓰고, 수집 중이 아니어도 패스 결과를 돌려준다', async () => {
    await enabled();
    statusPatch = { autoCollect: false };
    expect((await syncNow()).result).toMatchObject({ sync: 'failed', newTurns: 0, flushed: false });
    expect(calledMethods()).toEqual(['collection.status']); // 패스가 한 번 읽고 끝
  });

  it('캐시된 설정이 수집 중이 아니어도 지금 상태가 수집 중이면 flush 한다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), autoCollect: false });
    expect((await syncNow()).result).toMatchObject({ sync: 'off', flushed: true });
  });

  it('채팅 화면에서도 받는다', async () => {
    expect(await syncNow(chatPage)).toMatchObject({ ok: true, result: { sync: 'off', flushed: true } });
  });

  it.each([
    ['켬', { accountSync: { enabled: true, account: OTHER_ACCOUNT } }],
    ['끔', { accountSync: { enabled: false } }],
    ['다른 설정과 함께', { projectTopic: '주제', accountSync: { enabled: false } }],
  ])('웹의 rpc collection.configure 로 동기화를 %s 바꾸려 하면 수집기로 넘기지 않고 거절한다', async (_name, params) => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    const response = await send({ type: 'rpc', method: 'collection.configure', params }, fromPage('http://localhost:3000/collect'));
    expect(response).toEqual({ ok: false, error: '동기화 켬·끔은 확장 팝업에서만 바꿀 수 있어요' });
    expect(calledMethods()).not.toContain('collection.configure');
  });

  it('웹의 다른 collection.configure 는 그대로 수집기로 넘긴다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    const response = await send({ type: 'rpc', method: 'collection.configure', params: { projectTopic: '새 주제' } }, fromPage('http://localhost:3000/collect'));
    expect(response).toMatchObject({ ok: true });
    expect(calledMethods()).toContain('collection.configure');
  });

  it('웹의 rpc ext.syncNow 는 수집기로 넘기지 않고 같은 함수로 처리한다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    await enabled();
    const response = await send({ type: 'rpc', method: EXT_SYNC_NOW, params: { reason: 'review-open' } }, fromPage('http://localhost:3000/review'));
    expect(response).toEqual({ ok: true, result: { sync: 'ran', newTurns: 1, flushed: true } });
    expect(calledMethods()).not.toContain(EXT_SYNC_NOW);
  });

  it('flush 가 실패해도 패스 결과는 잃지 않고 실패 문구를 blockedReason 으로 돌려준다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    await enabled();
    nativeOverrides['collection.flush'] = { ok: false, error: '수집이 활성화되지 않았습니다.' };
    const response = await send({ type: 'rpc', method: EXT_SYNC_NOW, params: { reason: 'button' } }, fromPage('http://localhost:3000/review'));
    expect(response).toEqual({ ok: true, result: { sync: 'ran', newTurns: 1, flushed: false, blockedReason: '수집이 활성화되지 않았습니다.' } });
  });

  it('믿지 않는 웹 출처는 거절한다', async () => {
    const response = await send({ type: 'syncNow', params: { reason: 'button' } }, fromPage('https://example.com/'));
    expect(response).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
  });
});

describe('syncSet (프로젝트만 수집 켬·끔)', () => {
  const syncSet = (enabledFlag: boolean, project?: object, sender: object = fromPopup()) =>
    send({ type: 'syncSet', enabled: enabledFlag, project }, sender) as Promise<{ ok: boolean; result?: SyncState; error?: string }>;

  const configureCalls = () => nativeCalls.filter((c) => c.method === 'collection.configure').map((c) => c.params);

  it('켜면 계정을 수집기에 묶고, 상태를 저장하고, 알람을 만들고, 패스를 한 번 돈다', async () => {
    collectorSync = null; // 한 번도 켠 적 없음
    const response = await syncSet(true, PROJECT);
    expect(response.ok).toBe(true);
    expect(configureCalls()).toEqual([{ accountSync: { enabled: true, account: ACCOUNT } }]);
    expect(response.result).toMatchObject({ enabled: true, project: PROJECT, account: ACCOUNT, enabledAt: at(0), mode: 'idle', cursor: at(-10) });
    expect(detailIds()).toEqual(['c1']);
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toMatchObject({ periodInMinutes: 5 });
  });

  it('수집기가 이미 켜져 있으면 먼저 끄고 켠다 (켬 시각을 새로 찍게)', async () => {
    await syncSet(true, PROJECT); // 가짜 수집기는 처음부터 켜져 있다
    expect(configureCalls()).toEqual([{ accountSync: { enabled: false } }, { accountSync: { enabled: true, account: ACCOUNT } }]);
  });

  it('끄기를 수집기에 못 전하면 collectorOffPending 으로 두고, 그동안 패스를 돌지 않는다', async () => {
    await enabled();
    let offFails = true;
    let offAttempts = 0;
    vi.mocked(fakeBrowser.runtime.sendNativeMessage).mockImplementation((async (host: string, request: NativeRequest) => {
      if (request.method === 'collection.configure') {
        offAttempts += 1;
        if (offFails) throw new Error('Native host has exited.');
      }
      return fakeCollector(host, request);
    }) as never);
    expect(await syncSet(false)).toEqual({ ok: false, error: SYNC_OFF_PENDING_ERROR });
    expect(await state()).toMatchObject({ enabled: false, mode: 'off', collectorOffPending: true });
    expect(await fakeBrowser.alarms.get(SYNC_ALARM)).toBeUndefined();
    expect(await runSyncPass()).toMatchObject({ sync: 'off' });

    // 30초 refresh 알람마다 다시 보낸다: 아직 실패하면 그대로 두고, 성공하면 지운다
    const refreshAlarm = () => fakeBrowser.alarms.onAlarm.trigger({ name: 'refresh', scheduledTime: clock, persistAcrossSessions: false });
    await refreshAlarm();
    await vi.waitFor(() => expect(offAttempts).toBe(2));
    await settle();
    expect((await state()).collectorOffPending).toBe(true);
    offFails = false;
    await refreshAlarm();
    await vi.waitFor(async () => expect((await state()).collectorOffPending).toBe(false));
    expect(offAttempts).toBe(3);
    expect(collectorSync).toMatchObject({ enabled: false });
  });

  it('서비스 워커가 시작할 때 못 전한 끄기를 다시 보낸다', async () => {
    await syncStateItem.setValue({ ...SYNC_DEFAULTS, collectorOffPending: true });
    background.main();
    await vi.waitFor(async () => expect((await state()).collectorOffPending).toBe(false));
    expect(configureCalls()).toEqual([{ accountSync: { enabled: false } }]);
  });

  it('못 전한 끄기가 있으면 다음 켬 직전에 끄기부터 보낸다 (수집기가 꺼졌다고 답해도)', async () => {
    await syncStateItem.setValue({ ...SYNC_DEFAULTS, collectorOffPending: true });
    collectorSync = { enabled: false, account: ACCOUNT, since: null };
    expect(await syncSet(true, PROJECT)).toMatchObject({ ok: true, result: { enabled: true, collectorOffPending: false } });
    expect(configureCalls()).toEqual([{ accountSync: { enabled: false } }, { accountSync: { enabled: true, account: ACCOUNT } }]);
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

describe('syncProjects (프로젝트 고르기)', () => {
  const syncProjects = (sender: object = fromPopup()) => send({ type: 'syncProjects' }, sender);

  it('대표 탭의 sync.projects 를 그대로 돌려주고, 동기화가 꺼져 있어도 된다', async () => {
    expect((await state()).enabled).toBe(false);
    expect(await syncProjects()).toEqual({ ok: true, result: [PROJECT] });
    expect(tabCalls.map((c) => c.request)).toEqual([{ type: 'sync.projects' }]);
    expect(calledMethods()).toEqual([]);
  });

  it('탭이 없거나 로그아웃이면 syncSet 과 같은 문구', async () => {
    tabs = [];
    expect(await syncProjects()).toEqual({ ok: false, error: 'chatgpt.com 탭을 하나 열어 두세요' });
    tabs = [{ id: 11, active: true, url: 'https://chatgpt.com/' }];
    tabOverrides['sync.projects'] = tabError('logged_out');
    expect(await syncProjects()).toEqual({ ok: false, error: 'ChatGPT에 로그인하세요' });
  });

  it('채팅 화면과 웹에서 온 요청은 거절한다', async () => {
    expect(await syncProjects(chatPage)).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    expect(await syncProjects(fromPage('http://localhost:3000/review'))).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    expect(tabCalls).toHaveLength(0);
  });
});

describe('teamRecord (팀 기록 불러오기)', () => {
  const teamRecord = (sender: object) => send({ type: 'teamRecord' }, sender);
  const board = { items: [{ id: 'card-1' }] };
  const conflicts = { conflicts: [{ id: 'conflict-1' }] };

  beforeEach(() => {
    nativeOverrides['team.board'] = { ok: true, result: board };
    nativeOverrides['team.conflicts'] = { ok: true, result: conflicts };
  });

  it('채팅 화면과 팝업에서 수집기 응답을 그대로 {board, conflicts} 로 돌려준다', async () => {
    expect(await teamRecord(chatPage)).toEqual({ ok: true, result: { board, conflicts } });
    expect(await teamRecord(fromPopup())).toEqual({ ok: true, result: { board, conflicts } });
    expect(calledMethods().sort()).toEqual(['team.board', 'team.board', 'team.conflicts', 'team.conflicts']);
  });

  it('수집기 오류 문구는 그대로 넘긴다', async () => {
    nativeOverrides['team.conflicts'] = { ok: false, error: '팀 서버에 연결할 수 없습니다.' };
    expect(await teamRecord(chatPage)).toEqual({ ok: false, error: '팀 서버에 연결할 수 없습니다.' });
  });

  it('웹에서 온 요청은 거절한다', async () => {
    await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl: LOCAL_WEB_URL });
    expect(await teamRecord(fromPage('http://localhost:3000/board'))).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    expect(calledMethods()).not.toContain('team.board');
  });
});

describe('동기화로 고른 프로젝트에서는 화면 수집을 하지 않는다 (약속 8-1 R3)', () => {
  const uuid = 'c0ffee00-0000-4000-8000-000000000001';
  const syncedPage = `https://chatgpt.com/g/${PROJECT.gizmoId}-hackathon/c/${uuid}`;
  const otherProjectPage = `https://chatgpt.com/g/${OTHER_PROJECT_ID}-notes/c/${uuid}`;
  const plainPage = `https://chatgpt.com/c/${uuid}`;
  const screenMessages: CollectedMessage[] = [
    { id: 'chatgpt:m1', site: 'chatgpt', role: 'user', text: '팀원 질문', conversationId: uuid, collectedAt: at(0) },
    { id: 'chatgpt:m2', site: 'chatgpt', role: 'assistant', text: '답변', conversationId: uuid, collectedAt: at(0) },
  ];
  const collect = (trigger: 'auto' | 'manual' | 'selection', url: string) =>
    send({ type: 'collect', trigger, messages: screenMessages }, fromPage(url));
  const toasts = () => tabCalls.filter((c) => (c.request as { type: string }).type === 'toast').map((c) => c.request);
  const rightClick = (url: string) => menuClicked({ menuItemId: 'syncup-send-selection', selectionText: '팀 결정 내용' }, { id: 7, url, title: '대화' });

  beforeEach(() => enabled());

  it('같은 프로젝트의 자동 수집은 수집기로 보내지 않고 조용히 넘긴다', async () => {
    expect(await collect('auto', syncedPage)).toEqual({ ok: true, newMessages: 0, intakeIssues: 0 });
    expect(appendCalls()).toHaveLength(0);
  });

  it.each(['manual', 'selection'] as const)('같은 프로젝트의 %s 보내기는 거절하고 싱크 맞추기를 안내한다', async (trigger) => {
    expect(await collect(trigger, syncedPage)).toEqual({ ok: false, error: '이 프로젝트 대화는 동기화가 가져와요. 싱크 맞추기를 눌러 주세요' });
    expect(appendCalls()).toHaveLength(0);
  });

  it('프로젝트 홈 화면도 같은 프로젝트로 본다', async () => {
    expect(await collect('manual', `https://chatgpt.com/g/${PROJECT.gizmoId}-hackathon/project`)).toMatchObject({ ok: false });
  });

  it.each([
    ['다른 프로젝트', otherProjectPage],
    ['일반 대화', plainPage],
  ])('%s 은 지금처럼 화면 수집을 한다', async (_name, url) => {
    expect(await collect('manual', url)).toEqual({ ok: true, newMessages: 2, intakeIssues: 0 });
    expect(await collect('auto', url)).toMatchObject({ ok: true });
    expect(appendCalls().map((c) => c.params.flush)).toEqual([true, false]);
  });

  it('동기화가 꺼져 있으면 같은 프로젝트에서도 화면 수집을 한다', async () => {
    await syncStateItem.setValue({ ...(await state()), enabled: false, mode: 'off' });
    expect(await collect('auto', syncedPage)).toEqual({ ok: true, newMessages: 2, intakeIssues: 0 });
    expect(appendCalls()).toHaveLength(1);
  });

  it('우클릭 선택 보내기도 같은 프로젝트면 보내지 않고 안내한다', async () => {
    rightClick(syncedPage);
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toEqual({ type: 'toast', text: '이 프로젝트 대화는 동기화가 가져와요. 싱크 맞추기를 눌러 주세요', tone: 'error' });
    expect(appendCalls()).toHaveLength(0);
  });

  it('우클릭 선택 보내기는 다른 프로젝트에서는 보낸다', async () => {
    rightClick(otherProjectPage);
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    expect(appendCalls()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ tone: 'ok' });
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

  it('서비스 워커가 시작할 때 3분보다 오래된 running 은 idle 로 되돌리고 커서·pending 은 둔다', async () => {
    await enabled({ mode: 'running', lastPassStartedAt: at(-4), cursor: at(-30), pending: ['c7'] });
    background.main();
    await vi.waitFor(async () => expect((await state()).mode).toBe('idle'));
    expect(await state()).toMatchObject({ cursor: at(-30), pending: ['c7'], lastPassStartedAt: at(-4) });
  });

  it('3분이 안 된 running 은 그대로 둔다 (다른 곳에서 막 시작한 패스일 수 있다)', async () => {
    await enabled({ mode: 'running', lastPassStartedAt: at(-2) });
    background.main();
    await settle();
    await settle();
    expect((await state()).mode).toBe('running');
  });

  it('브라우저를 시작하면 패스를 한 번 돈다', async () => {
    await enabled();
    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(async () => expect((await state()).stats.passes).toBe(1));
  });
});
