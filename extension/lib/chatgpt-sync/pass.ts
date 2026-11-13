// 동기화 패스 (docs/sync-contract.md 5장 "패스"). 고른 프로젝트에서 바뀐 대화를 받아 수집기 turns.append 로 넣는다.
// 순서: 멈춤 확인 → 창 읽기 → 대상 고르기 → 대화 상세 → 커서 → 쉼. 한 번에 하나만 돈다.
import { storage } from '#imports';
import type { ExtStatus, SyncNowResult, SyncWindow } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';
import { rpc } from '../collector-rpc';
import type { SyncConversationData, SyncProjectPage, TabSyncError, TabSyncResult } from '../messages';
import { findLeaderTab, type LeaderTab } from './leader-tab';
import {
  SYNC_APPEND_CHUNK,
  SYNC_CURSOR_SLACK_MINUTES,
  SYNC_DETAIL_GAP_MS,
  SYNC_FORBIDDEN_REST_MINUTES,
  SYNC_MAX_DETAILS_PER_PASS,
  SYNC_REST_DEFAULT_MINUTES,
  syncStateItem,
  type SyncState,
  type SyncStopReason,
} from './state';

// 시험에서 바꿔 끼우는 시계·난수·기다리기
export const syncTiming = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// 이 묶음에 "남김"(생성 중·network)이 있었는지. 묶음 = 목록을 읽어 pending 을 만든 때부터 pending 이 빌 때까지(여러 패스).
// 남김 대화는 pending 에서 빠지므로, 묶음 끝에 커서를 올리면 그 대화를 다시 보지 못한다. SyncState 는 약속이라 따로 둔다
export const syncLeftoverItem = storage.defineItem<boolean>('local:chatgptSyncLeftover', { fallback: false });

export interface PassResult {
  sync: SyncNowResult['sync'];
  newTurns: number;
}

type PassEnd =
  | { kind: 'done' } // 끝까지 돎 (대화별 남김은 있을 수 있음)
  | { kind: 'stop'; reason: SyncStopReason }
  | { kind: 'rest'; reason: 'rate_limited' | 'forbidden'; until: number }
  | { kind: 'error' }; // 일시 오류: 수집기 실패, 목록·세션의 network·not_found, 대표 탭 끊김

type TabFailure = Extract<TabSyncResult<unknown>, { ok: false }>;

interface AppendResult {
  newMessages: number;
  outsideWindow?: number; // 옛 수집기는 없음
  newTurns?: number;
}

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const detailGap = () => SYNC_DETAIL_GAP_MS[0] + syncTiming.random() * (SYNC_DETAIL_GAP_MS[1] - SYNC_DETAIL_GAP_MS[0]);

// 켬마다 enabledAt 이 새로 찍힌다. 패스 도중 끄거나 다시 켜면 이 값이 달라지고, 패스는 결과를 쓰지 않고 멈춘다
const runKey = (s: SyncState) => `${s.enabledAt}|${s.project?.gizmoId}|${s.account}`;

class Superseded extends Error {}

class PassRun {
  readonly key: string;
  pending: string[];
  pendingPassStartedAt: string | null;
  stats: SyncState['stats'];
  newTurns = 0;
  error: SyncState['lastError'] = null;

  constructor(
    start: SyncState,
    readonly startedAt: number,
  ) {
    this.key = runKey(start);
    this.pending = [...start.pending];
    this.pendingPassStartedAt = start.pendingPassStartedAt;
    this.stats = { ...start.stats, passes: start.stats.passes + 1 };
  }

  /** 그사이 끄거나 다시 켰으면 Superseded. 탭 응답마다 확인해서, 끈 뒤에 받은 대화는 수집기로 보내지 않는다 */
  async ensureCurrent() {
    const latest = await syncStateItem.getValue();
    if (!latest.enabled || runKey(latest) !== this.key) throw new Superseded();
    return latest;
  }

  /** 최신 상태에 이 패스가 맡은 필드만 덮어쓴다 */
  async save(fields: Partial<SyncState>) {
    const latest = await this.ensureCurrent();
    await syncStateItem.setValue({ ...latest, ...fields });
  }

  progress(): Partial<SyncState> {
    return { pending: this.pending, pendingPassStartedAt: this.pendingPassStartedAt, stats: this.stats };
  }

  fail(code: TabSyncError | 'collector') {
    this.error = { code, at: iso(syncTiming.now()) };
  }

  /** 대화 하나를 끝냈다. left = 이번 묶음의 남김 */
  async finishConversation(id: string, left: boolean) {
    this.pending = this.pending.filter((p) => p !== id);
    if (left) await syncLeftoverItem.setValue(true);
    await this.save(this.progress());
  }

  async append(messages: CollectedMessage[]) {
    for (const chunk of appendChunks(messages)) {
      const result = await rpc<AppendResult>('turns.append', { messages: chunk });
      this.newTurns += result.newTurns ?? 0;
      this.stats.turnsSent += result.newTurns ?? 0;
      this.stats.outsideWindow += result.outsideWindow ?? 0;
    }
  }
}

/**
 * turns.append 한 번에 SYNC_APPEND_CHUNK 개 이하. 수집기는 턴(turnId) 단위로 창과 C4-b 를 판단하므로 턴을 가르지 않는다.
 * 한 턴이 상한보다 길 때만 그 턴을 상한대로 자른다
 */
export function appendChunks(messages: CollectedMessage[]): CollectedMessage[][] {
  const turns: CollectedMessage[][] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (last && last[0]?.turnId === message.turnId) last.push(message);
    else turns.push([message]);
  }
  const chunks: CollectedMessage[][] = [];
  let chunk: CollectedMessage[] = [];
  for (const turn of turns) {
    if (chunk.length && chunk.length + turn.length > SYNC_APPEND_CHUNK) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(...turn);
    while (chunk.length > SYNC_APPEND_CHUNK) chunks.push(chunk.splice(0, SYNC_APPEND_CHUNK));
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** 수집 중: 일시정지도 종료도 아님 (ExtStatus.autoCollect = false 가 일시정지·종료) */
function isCollecting(status: ExtStatus, now: number) {
  const end = Date.parse(status.endsAt);
  return status.autoCollect && !(end <= now);
}

/** 실효 커서 = max(창 시작, 커서). 날짜로 비교한다 */
function effectiveCursor(windows: SyncWindow[], cursor: string | null) {
  const times = [Date.parse(windows[0]?.start ?? ''), cursor ? Date.parse(cursor) : NaN].filter(Number.isFinite);
  return times.length ? Math.max(...times) : -Infinity;
}

function tabFailureEnd(run: PassRun, failure: TabFailure): PassEnd {
  run.fail(failure.error);
  const now = syncTiming.now();
  switch (failure.error) {
    case 'rate_limited': {
      const sec = failure.retryAfterSec;
      const ms = sec && sec > 0 ? sec * 1000 : SYNC_REST_DEFAULT_MINUTES * MINUTE;
      return { kind: 'rest', reason: 'rate_limited', until: now + ms };
    }
    case 'forbidden':
      return { kind: 'rest', reason: 'forbidden', until: now + SYNC_FORBIDDEN_REST_MINUTES * MINUTE };
    case 'logged_out':
    case 'shape_changed':
      return { kind: 'stop', reason: failure.error };
    default:
      return { kind: 'error' };
  }
}

/** 탭 응답이 실패거나 다른 계정이면 패스를 끝낼 이유, 아니면 null */
function tabEnd(run: PassRun, response: TabSyncResult<unknown>, account: string): PassEnd | null {
  if (!response.ok) return tabFailureEnd(run, response);
  return response.account === account ? null : { kind: 'stop', reason: 'account_mismatch' };
}

/** 고른 프로젝트의 목록을 쪽마다 읽어 대상 id 를 모은다. 실패하면 모은 것을 버린다(일부만 넣고 커서를 올리면 놓친다) */
async function listTargets(run: PassRun, leader: LeaderTab, gizmoId: string, since: number, account: string): Promise<string[] | PassEnd> {
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page > 0) await syncTiming.sleep(detailGap()); // 목록 429 가 가장 아프므로 쪽 사이에도 간격을 둔다
    const response: TabSyncResult<SyncProjectPage> = await leader.request({ type: 'sync.projectPage', gizmoId, cursor });
    await run.ensureCurrent();
    const end = tabEnd(run, response, account);
    if (end || !response.ok) return end ?? { kind: 'error' };
    let reachedOld = false;
    for (const item of response.data.items) {
      if (Date.parse(item.updateTime) < since) reachedOld = true;
      else if (!item.isArchived) ids.add(item.id);
    }
    const next: string | null = response.data.nextCursor;
    if (reachedOld || !next || seenCursors.has(next)) return [...ids];
    seenCursors.add(next);
    cursor = next;
  }
}

async function fetchDetails(run: PassRun, leader: LeaderTab, windows: SyncWindow[], account: string): Promise<PassEnd> {
  const batch = run.pending.slice(0, SYNC_MAX_DETAILS_PER_PASS);
  for (const [index, id] of batch.entries()) {
    if (index > 0) await syncTiming.sleep(detailGap());
    const response = await leader.request<SyncConversationData>({ type: 'sync.conversation', id, windows });
    await run.ensureCurrent();
    if (!response.ok && response.error === 'not_found') {
      await run.finishConversation(id, false); // 지운 대화: 건너뜀
      continue;
    }
    if (!response.ok && response.error === 'network') {
      run.fail('network');
      await run.finishConversation(id, true);
      if (leader.lost) return { kind: 'error' }; // 탭이 사라졌으면 남은 대화는 다음 패스에 (요청마다 20초씩 기다리지 않게)
      continue;
    }
    const end = tabEnd(run, response, account);
    if (end || !response.ok) return end ?? { kind: 'error' }; // 쉼·멈춤: 이 대화는 pending 에 남는다
    try {
      await run.append(response.data.messages);
    } catch {
      run.fail('collector'); // 이 대화는 pending 에 남긴다. 다시 보내도 수집기가 id 로 거른다
      return { kind: 'error' };
    }
    run.stats.conversationsChecked += 1;
    await run.finishConversation(id, response.data.inProgress);
  }
  return { kind: 'done' };
}

async function runSteps(run: PassRun, state: SyncState): Promise<PassEnd> {
  const project = state.project!;
  const account = state.account!;
  // 1. 멈춤 확인
  let status: ExtStatus;
  try {
    status = await rpc<ExtStatus>('collection.status');
  } catch {
    run.fail('collector');
    return { kind: 'error' };
  }
  if (!isCollecting(status, syncTiming.now())) return { kind: 'stop', reason: 'collection_paused' };
  const found = await findLeaderTab<null>({ type: 'sync.session' });
  if (!found) return { kind: 'stop', reason: 'no_tab' };
  await run.ensureCurrent();
  const sessionEnd = tabEnd(run, found.response, account);
  if (sessionEnd) return sessionEnd;
  // 2. 창 읽기
  const windows = status.syncWindows ?? [];
  if (!windows.length) return { kind: 'done' };
  // 3. 대상 고르기 (pending 이 남아 있으면 이어 간다)
  if (!run.pending.length) {
    const targets = await listTargets(run, found.leader, project.gizmoId, effectiveCursor(windows, state.cursor), account);
    if (!Array.isArray(targets)) return targets;
    run.pending = targets;
    run.pendingPassStartedAt = iso(run.startedAt);
    await syncLeftoverItem.setValue(false);
    await run.save(run.progress());
  }
  // 4. 대화 상세
  return fetchDetails(run, found.leader, windows, account);
}

const SYNC_OF: Record<PassEnd['kind'], SyncNowResult['sync']> = { done: 'ran', stop: 'failed', rest: 'resting', error: 'failed' };

async function finish(run: PassRun, end: PassEnd): Promise<PassResult> {
  const fields: Partial<SyncState> = {
    ...run.progress(),
    mode: 'idle',
    stopReason: null,
    lastError: run.error,
    lastPassFinishedAt: iso(syncTiming.now()),
  };
  if (end.kind === 'stop') Object.assign(fields, { mode: 'stopped', stopReason: end.reason });
  if (end.kind === 'rest') Object.assign(fields, { mode: 'rest', restUntil: iso(end.until), restReason: end.reason });
  // 5. 커서: pending 이 비고, 이 묶음에 남김이 없고, 쉼 없이 끝났을 때만 올린다
  if (end.kind === 'done' && !run.pending.length && run.pendingPassStartedAt) {
    if (!(await syncLeftoverItem.getValue())) {
      fields.cursor = iso(Date.parse(run.pendingPassStartedAt) - SYNC_CURSOR_SLACK_MINUTES * MINUTE);
    }
    fields.pendingPassStartedAt = null;
  }
  await run.save(fields);
  const sync = end.kind === 'stop' && end.reason === 'no_tab' ? 'no-tab' : SYNC_OF[end.kind];
  return { sync, newTurns: run.newTurns };
}

async function pass(): Promise<PassResult> {
  const state = await syncStateItem.getValue();
  if (!state.enabled || !state.project || !state.account) return { sync: 'off', newTurns: 0 };
  const now = syncTiming.now();
  if (state.restUntil && Date.parse(state.restUntil) > now) return { sync: 'resting', newTurns: 0 };
  const run = new PassRun(state, now);
  try {
    await run.save({ mode: 'running', stopReason: null, restUntil: null, restReason: null, lastPassStartedAt: iso(now), stats: run.stats });
    return await finish(run, await runSteps(run, state));
  } catch (error) {
    if (error instanceof Superseded) {
      const latest = await syncStateItem.getValue();
      return { sync: latest.enabled ? 'busy' : 'off', newTurns: run.newTurns };
    }
    // 예상 못 한 실패(저장소 등): 다음 알람이 다시 돌도록 idle 로 둔다
    await run.save({ mode: 'idle', lastPassFinishedAt: iso(syncTiming.now()) }).catch(() => {});
    return { sync: 'failed', newTurns: run.newTurns };
  }
}

let running: Promise<PassResult> | null = null;

/** 패스를 한 번 돈다. 이미 돌고 있으면 기다리지 않고 busy */
export function runSyncPass(): Promise<PassResult> {
  if (running) return Promise.resolve({ sync: 'busy', newTurns: 0 });
  running = pass().finally(() => (running = null));
  return running;
}

/** 돌고 있는 패스가 있으면 끝날 때까지 기다린다 (켬 직후 패스용) */
export const waitForRunningPass = async () => {
  await running?.catch(() => {});
};
