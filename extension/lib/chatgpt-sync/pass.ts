// 동기화 패스 (docs/sync-contract.md 5장 "패스"). 고른 프로젝트에서 바뀐 대화를 받아 수집기 turns.append 로 넣는다.
// 순서: 멈춤 확인 → 창 읽기 → 대상 고르기 → 대화 상세 → 커서 → 쉼. 한 번에 하나만 돈다.
import { storage } from '#imports';
import type { ExtStatus, SyncNowResult, SyncWindow } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';
import { CollectorUnreachable, rpc } from '../collector-rpc';
import type { SyncConversationData, SyncProjectPage, TabSyncError, TabSyncResult } from '../messages';
import { findLeaderTab, type LeaderTab } from './leader-tab';
import {
  SYNC_APPEND_CHUNK,
  SYNC_APPEND_MAX_BYTES,
  SYNC_CURSOR_SLACK_MINUTES,
  SYNC_DETAIL_GAP_MS,
  SYNC_FORBIDDEN_REST_MINUTES,
  SYNC_MAX_CONVERSATION_FAILURES,
  SYNC_MAX_DETAILS_PER_PASS,
  SYNC_REST_DEFAULT_MINUTES,
  SYNC_STALE_IN_PROGRESS_MINUTES,
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

// 이 묶음에 "남김"(생성 중·대화별 실패)이 있었는지. 묶음 = 목록을 읽어 pending 을 만든 때부터 pending 이 빌 때까지(여러 패스).
// 남김 대화는 pending 에서 빠지므로, 묶음 끝에 커서를 올리면 그 대화를 다시 보지 못한다. SyncState 는 약속이라 따로 둔다
export const syncLeftoverItem = storage.defineItem<boolean>('local:chatgptSyncLeftover', { fallback: false });

export interface PassResult {
  sync: SyncNowResult['sync'];
  newTurns: number;
  status?: ExtStatus; // 이 패스가 읽은 collection.status (syncNow 의 flush 판단에 쓴다). 1단계 전에 끝났으면 없음
}

type PassEnd =
  | { kind: 'done' } // 끝까지 돎 (대화별 남김은 있을 수 있음)
  | { kind: 'stop'; reason: SyncStopReason }
  | { kind: 'rest'; reason: 'rate_limited' | 'forbidden'; until: number }
  | { kind: 'error' }; // 일시 오류: 수집기 실패, 세션·목록의 network·not_found, 대표 탭 끊김

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
  failures: Record<string, number>;
  stats: SyncState['stats'];
  status: ExtStatus | undefined;
  newTurns = 0;
  error: SyncState['lastError'] = null;

  constructor(
    start: SyncState,
    readonly startedAt: number,
  ) {
    this.key = runKey(start);
    this.pending = [...start.pending];
    this.pendingPassStartedAt = start.pendingPassStartedAt;
    this.failures = { ...start.failures };
    this.stats = { ...start.stats, passes: start.stats.passes + 1 };
  }

  /** 그사이 끄거나 다시 켰으면 Superseded. 탭 응답마다 확인해서, 끈 뒤에 받은 대화는 수집기로 보내지 않는다 */
  async ensureCurrent() {
    const latest = await syncStateItem.getValue();
    if (!latest.enabled || latest.collectorOffPending || runKey(latest) !== this.key) throw new Superseded();
    return latest;
  }

  /** 최신 상태에 이 패스가 맡은 필드만 덮어쓴다 */
  async save(fields: Partial<SyncState>) {
    const latest = await this.ensureCurrent();
    await syncStateItem.setValue({ ...latest, ...fields });
  }

  progress(): Partial<SyncState> {
    return { pending: this.pending, pendingPassStartedAt: this.pendingPassStartedAt, failures: this.failures, stats: this.stats };
  }

  fail(code: TabSyncError | 'collector') {
    this.error = { code, at: iso(syncTiming.now()) };
  }

  /** 대화 하나를 끝냈다(받았거나 건너뜀). left = 이번 묶음의 남김 */
  async finishConversation(id: string, left: boolean) {
    this.pending = this.pending.filter((p) => p !== id);
    if (left) await syncLeftoverItem.setValue(true);
    await this.save(this.progress());
  }

  /** 받았거나 지워진 대화: 실패 수를 지운다 */
  async settled(id: string, left: boolean) {
    delete this.failures[id];
    await this.finishConversation(id, left);
  }

  /**
   * 대화별 실패(network·그 대화의 shape_changed·turns.append 거절). 실패 수를 늘리고 남김으로 둔다.
   * SYNC_MAX_CONVERSATION_FAILURES 번째부터는 건너뜀: 남김이 아니라 커서를 붙잡지 않는다. 실패 수는 받을 때까지 남긴다
   */
  async conversationFailed(id: string, code: TabSyncError | 'collector') {
    this.fail(code);
    const count = (this.failures[id] ?? 0) + 1;
    this.failures[id] = count;
    const skip = count >= SYNC_MAX_CONVERSATION_FAILURES;
    if (skip) this.stats.skippedConversations += 1;
    await this.finishConversation(id, !skip);
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

/** JSON 으로 보낼 때의 추정 바이트 수. native host 가 ensure_ascii 로 다시 직렬화하므로 ASCII 밖 글자(UTF-16 한 단위)는 \uXXXX 6바이트 */
export function estimateJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < json.length; i++) bytes += json.charCodeAt(i) > 0x7f ? 6 : 1;
  return bytes;
}

const APPEND_ENVELOPE_BYTES = 128; // {"version":1,"method":"turns.append","params":{"messages":[…]}} 의 나머지

/**
 * turns.append 한 번에 SYNC_APPEND_CHUNK 개 이하, 추정 SYNC_APPEND_MAX_BYTES 이하. 수집기는 턴(turnId) 단위로 창과 C4-b 를
 * 판단하므로 턴을 가르지 않는다. 한 턴이 상한보다 클 때만 그 턴을 메시지 단위로 자른다
 */
export function appendChunks(messages: CollectedMessage[]): CollectedMessage[][] {
  const turns: CollectedMessage[][] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (last && last[0]?.turnId === message.turnId) last.push(message);
    else turns.push([message]);
  }
  const fits = (count: number, bytes: number) => count <= SYNC_APPEND_CHUNK && bytes <= SYNC_APPEND_MAX_BYTES;
  const chunks: CollectedMessage[][] = [];
  let chunk: CollectedMessage[] = [];
  let chunkBytes = APPEND_ENVELOPE_BYTES;
  const flush = () => {
    if (chunk.length) chunks.push(chunk);
    chunk = [];
    chunkBytes = APPEND_ENVELOPE_BYTES;
  };
  const add = (message: CollectedMessage, bytes: number) => {
    if (!fits(chunk.length + 1, chunkBytes + bytes)) flush();
    chunk.push(message);
    chunkBytes += bytes;
  };
  for (const turn of turns) {
    const sizes = turn.map((m) => estimateJsonBytes(m) + 1); // + 쉼표
    const turnBytes = sizes.reduce((a, b) => a + b, 0);
    if (!fits(chunk.length + turn.length, chunkBytes + turnBytes)) flush(); // 턴 전체가 다음 묶음으로
    turn.forEach((m, i) => add(m, sizes[i]!)); // 턴 혼자 상한을 넘을 때만 여기서 잘린다
  }
  flush();
  return chunks;
}

/** 수집 중: 일시정지도 종료도 아님 (ExtStatus.autoCollect = false 가 일시정지·종료) */
function isCollecting(status: ExtStatus, now: number) {
  const end = Date.parse(status.endsAt);
  return status.autoCollect && !(end <= now);
}

/** 수집기 쪽 동기화가 이 확장이 켠 계정으로 켜져 있는지 (상태 폴더를 새로 만들었거나 다른 곳에서 끄면 아니다) */
const collectorSyncOn = (status: ExtStatus, account: string) => !!status.accountSync?.enabled && status.accountSync.account === account;

/** 실효 커서 = max(창 시작, 커서). 날짜로 비교한다 */
function effectiveCursor(windows: SyncWindow[], cursor: string | null) {
  const times = [Date.parse(windows[0]?.start ?? ''), cursor ? Date.parse(cursor) : NaN].filter(Number.isFinite);
  return times.length ? Math.max(...times) : -Infinity;
}

/**
 * 미완료 턴이 아직 생성 중일 수 있는지(= 남김). inProgressAt 이 10분보다 오래됐으면 멈춘 답으로 보고 커서를 붙잡지 않는다.
 * inProgressAt 이 없으면(시각 없는 턴) 오래됐는지 알 수 없으므로 남김으로 둔다
 */
function stillInProgress(data: SyncConversationData, now: number) {
  if (!data.inProgress) return false;
  const at = data.inProgressAt ? Date.parse(data.inProgressAt) : NaN;
  return !(now - at > SYNC_STALE_IN_PROGRESS_MINUTES * MINUTE);
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
    case 'shape_changed': // 세션·목록 응답의 모양 오류만 여기로 온다 (대화 상세는 대화별 실패)
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
      else if (!item.isArchived && !item.isTemporary) ids.add(item.id);
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
      await run.settled(id, false); // 지운 대화: 건너뜀
      continue;
    }
    if (!response.ok && (response.error === 'network' || response.error === 'shape_changed')) {
      await run.conversationFailed(id, response.error);
      if (leader.lost) return { kind: 'error' }; // 탭이 사라졌으면 남은 대화는 다음 패스에 (요청마다 20초씩 기다리지 않게)
      continue;
    }
    const end = tabEnd(run, response, account);
    if (end || !response.ok) return end ?? { kind: 'error' }; // 쉼·멈춤: 이 대화는 pending 에 남는다
    try {
      await run.append(response.data.messages);
    } catch (error) {
      run.fail('collector');
      // 수집기에 닿지 못함: 대화 탓이 아니므로 세지 않고 pending 에 둔다. 다시 보내도 수집기가 id 로 거른다
      if (error instanceof CollectorUnreachable) return { kind: 'error' };
      // 거절: 그 대화의 실패로 센다. 거절 까닭이 수집 상태일 수도 있어 남은 대화는 다음 패스에 (한 번에 여러 대화를 세지 않게)
      await run.conversationFailed(id, 'collector');
      return { kind: 'error' };
    }
    run.stats.conversationsChecked += 1;
    await run.settled(id, stillInProgress(response.data, syncTiming.now()));
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
  run.status = status;
  if (!isCollecting(status, syncTiming.now())) return { kind: 'stop', reason: 'collection_paused' };
  if (!collectorSyncOn(status, account)) return { kind: 'stop', reason: 'collector_off' };
  const found = await findLeaderTab<null>({ type: 'sync.session' });
  if (!found) return { kind: 'stop', reason: 'no_tab' };
  await run.ensureCurrent();
  const sessionEnd = tabEnd(run, found.response, account);
  if (sessionEnd) return sessionEnd;
  // 2. 창 읽기 (1에서 읽은 상태)
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
  return { sync, newTurns: run.newTurns, status: run.status };
}

async function pass(): Promise<PassResult> {
  const state = await syncStateItem.getValue();
  // 끄기를 수집기에 아직 전하지 못했으면(collectorOffPending) 돌지 않는다
  if (!state.enabled || state.collectorOffPending || !state.project || !state.account) return { sync: 'off', newTurns: 0 };
  const now = syncTiming.now();
  if (state.restUntil && Date.parse(state.restUntil) > now) return { sync: 'resting', newTurns: 0 };
  const run = new PassRun(state, now);
  try {
    await run.save({ mode: 'running', stopReason: null, restUntil: null, restReason: null, lastPassStartedAt: iso(now), stats: run.stats });
    return await finish(run, await runSteps(run, state));
  } catch (error) {
    if (error instanceof Superseded) {
      const latest = await syncStateItem.getValue();
      return { sync: latest.enabled ? 'busy' : 'off', newTurns: run.newTurns, status: run.status };
    }
    // 예상 못 한 실패(저장소 등): 다음 알람이 다시 돌도록 idle 로 둔다
    await run.save({ mode: 'idle', lastPassFinishedAt: iso(syncTiming.now()) }).catch(() => {});
    return { sync: 'failed', newTurns: run.newTurns, status: run.status };
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
