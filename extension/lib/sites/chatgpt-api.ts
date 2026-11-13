// ChatGPT 내부 API 탭 클라이언트 (계정 동기화, docs/sync-contract.md 4장).
// chatgpt.com 탭의 콘텐츠 스크립트가 같은 출처 fetch 로 부른다. 백그라운드는 runtime 메시지(TabSyncRequest)로 시키고 sendResponse 로 받는다.
// - 토큰은 이 클로저의 메모리에만 둔다. 원본 JSON·제목·토큰은 탭 밖으로 내보내지 않는다.
// - 실제 chatgpt.com 에는 시험에서 요청하지 않는다. fetch 를 주입할 수 있고 시험은 가짜 fetch 로만 한다.
import type { SyncWindow } from '@shared/bridge';
import { normalizeConversation, turnsInWindows, type RawConversation } from '@shared/chatgpt-conversation';
import type { CollectedMessage } from '@shared/collector';
import type {
  SyncConversationData,
  SyncConversationRef,
  SyncProject,
  SyncProjectPage,
  TabSyncError,
  TabSyncRequest,
  TabSyncResponse,
  TabSyncResult,
} from '@/lib/messages';

/** 수집기 한도(collector/turn_intake.py MAX_MESSAGE_TEXT)와 같다 */
export const MAX_MESSAGE_TEXT = 20000;
/** 프로젝트 목록을 쪽으로 읽을 때의 상한 (한 번에 다 오는 게 보통이라 넉넉히) */
const MAX_PROJECT_PAGES = 10;
/** 프로젝트 대화 목록 첫 쪽의 cursor. P10(실제 응답 확인) 전 추정값이라 여기 한 곳에서만 쓴다 */
export const FIRST_PAGE_CURSOR = '0';

const SESSION_PATH = '/api/auth/session';
const PROJECTS_PATH = '/backend-api/gizmos/snorlax/sidebar';
const projectPagePath = (gizmoId: string, cursor: string | null) =>
  `/backend-api/gizmos/${encodeURIComponent(gizmoId)}/conversations?cursor=${encodeURIComponent(cursor ?? FIRST_PAGE_CURSOR)}`;
const conversationPath = (id: string) => `/backend-api/conversation/${encodeURIComponent(id)}`;

export interface ChatgptApiOptions {
  fetch?: typeof fetch; // 시험용 주입. 기본은 전역 fetch
  now?: () => number; // 시험용 시계 (ms)
}

export interface ChatgptApi {
  /** 요청 하나를 처리해 늘 TabSyncResponse 로 답한다 (던지지 않는다) */
  handle(request: TabSyncRequest): Promise<TabSyncResponse>;
}

/** 콘텐츠 스크립트가 이 클라이언트로 넘길 메시지인지: type 이 `sync.` 로 시작하는 것만 */
export function isSyncRequest(message: unknown): message is TabSyncRequest {
  const type = (message as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' && type.startsWith('sync.');
}

// ── 작은 도구 ──
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 숫자(유닉스 초)와 ISO 문자열이 섞여 온다. 둘 다 ISO 로. 못 바꾸면 null */
function isoOf(value: unknown): string | null {
  let ms: number;
  if (typeof value === 'number') ms = value * 1000;
  else if (typeof value === 'string') ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value);
  else return null;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(Math.round(ms));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const cursorOf = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;

/** 20000자가 넘으면 19999자까지 남기고 끝에 … 을 붙인다 (서러게이트 쌍이 반으로 잘리지 않게) */
export function clipText(text: string): string {
  if (text.length <= MAX_MESSAGE_TEXT) return text;
  let end = MAX_MESSAGE_TEXT - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Retry-After: 초 또는 HTTP 날짜. 0 이하·읽을 수 없는 값은 없는 것으로 본다(쉼 시간은 스케줄러가 정한다) */
function retryAfterSec(header: string | null, nowMs: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const sec = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - nowMs) / 1000);
  return Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

const BOT_CHECK_HTML = /^\s*<(?:!doctype|html)|just a moment|cf-chl|cf-challenge|verify you are human|unusual activity/i;

// ── 응답 분류 ──
type Failure = { ok: false; error: TabSyncError; retryAfterSec?: number };
type Fetched = { ok: true; json: unknown } | Failure | { ok: false; unauthorized: true };
const fail = (error: TabSyncError, retry?: number): Failure => (retry === undefined ? { ok: false, error } : { ok: false, error, retryAfterSec: retry });

interface Session {
  token: string;
  account: string; // sha256(UTF-8(user.id)) 소문자 hex
  expiresAtMs: number | null;
}
type SessionResult = { ok: true; session: Session } | Failure;

export function createChatgptApi(options: ChatgptApiOptions = {}): ChatgptApi {
  const send: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;

  let session: Session | null = null; // 메모리에만 둔다
  let loading: Promise<SessionResult> | null = null;

  /** GET 한 번. HTTP 상태와 응답 본문을 오류 분류(4장)로 바꾼다 */
  async function get(path: string, token: string | null): Promise<Fetched> {
    let res: Response;
    try {
      res = await send(path, {
        method: 'GET',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return fail('network');
    }
    if (res.status === 401) return { ok: false, unauthorized: true };
    if (res.status === 429) return fail('rate_limited', retryAfterSec(res.headers.get('Retry-After'), now()));
    if (res.status === 403) return fail('forbidden');
    if (res.status === 404) return fail('not_found');
    if (res.status >= 500 || res.status === 408) return fail('network');
    if (!res.ok) return fail('shape_changed'); // 그 밖의 4xx·3xx: 주소나 규칙이 바뀐 것으로 본다

    if (/text\/html/i.test(res.headers.get('Content-Type') ?? '')) return fail('forbidden'); // 봇 확인 화면
    let body: string;
    try {
      body = await res.text();
    } catch {
      return fail('network');
    }
    try {
      return { ok: true, json: JSON.parse(body) };
    } catch {
      return fail(BOT_CHECK_HTML.test(body) ? 'forbidden' : 'shape_changed');
    }
  }

  /** GET /api/auth/session → 토큰·계정 해시. accessToken 이 없으면 logged_out */
  async function loadSession(): Promise<SessionResult> {
    const res = await get(SESSION_PATH, null);
    if ('unauthorized' in res) {
      session = null;
      return fail('logged_out');
    }
    if (!res.ok) return res;
    const body = asRecord(res.json);
    if (!body) return fail('shape_changed');
    const token = body.accessToken;
    if (token === undefined || token === null || token === '') {
      session = null;
      return fail('logged_out');
    }
    const userId = asRecord(body.user)?.id;
    if (typeof token !== 'string' || typeof userId !== 'string' || !userId) return fail('shape_changed');
    const expires = typeof body.expires === 'string' ? Date.parse(body.expires) : NaN;
    session = { token, account: await sha256Hex(userId), expiresAtMs: Number.isNaN(expires) ? null : expires };
    return { ok: true, session };
  }

  /** 토큰이 있고 안 만료됐으면 그대로, 아니면(또는 force) 다시 받는다. 동시에 부르면 한 번만 받는다 */
  function ensureSession(force: boolean): Promise<SessionResult> {
    if (!force && session && (session.expiresAtMs === null || session.expiresAtMs > now())) return Promise.resolve({ ok: true, session });
    loading ??= loadSession().finally(() => {
      loading = null;
    });
    return loading;
  }

  /** 토큰을 붙여 GET. 401 이면 토큰을 한 번 다시 받아 다시 시도하고, 그래도 401 이면 logged_out */
  async function authedGet(path: string): Promise<{ result: Fetched; account?: string }> {
    let started = await ensureSession(false);
    if (!started.ok) return { result: started, account: session?.account };
    let res = await get(path, started.session.token);
    if ('unauthorized' in res) {
      session = null;
      started = await ensureSession(true);
      if (!started.ok) return { result: started };
      res = await get(path, started.session.token);
      if ('unauthorized' in res) {
        session = null;
        return { result: fail('logged_out'), account: started.session.account };
      }
    }
    return { result: res, account: started.session.account };
  }

  const done = <T>(account: string | undefined, data: T): TabSyncResult<T> => (account ? { ok: true, account, data } : fail('shape_changed'));
  const failed = (result: Failure, account: string | undefined): TabSyncResult<never> => (account ? { ...result, account } : result);

  /** 인증 GET + 본문 해석. parse 가 null 을 주면 필수 필드가 없는 것이라 shape_changed */
  async function read<T>(path: string, parse: (json: unknown) => T | null): Promise<TabSyncResult<T>> {
    const { result, account } = await authedGet(path);
    if ('unauthorized' in result) return failed(fail('logged_out'), account);
    if (!result.ok) return failed(result, account);
    const data = parse(result.json);
    return data === null ? failed(fail('shape_changed'), account) : done(account, data);
  }

  async function sessionCheck(): Promise<TabSyncResult<null>> {
    const started = await ensureSession(true);
    return started.ok ? { ok: true, account: started.session.account, data: null } : failed(started, session?.account);
  }

  // 사이드바: items[].gizmo.gizmo.id · items[].gizmo.gizmo.display.name 이 필수
  function parseSidebar(json: unknown): { projects: SyncProject[]; cursor: string | null } | null {
    const body = asRecord(json);
    if (!body || !Array.isArray(body.items)) return null;
    const projects: SyncProject[] = [];
    for (const item of body.items) {
      const gizmo = asRecord(asRecord(asRecord(item)?.gizmo)?.gizmo);
      const id = gizmo?.id;
      const name = asRecord(gizmo?.display)?.name;
      if (typeof id !== 'string' || !id || typeof name !== 'string') return null;
      projects.push({ gizmoId: id, name });
    }
    return { projects, cursor: cursorOf(body.cursor) };
  }

  async function projects(): Promise<TabSyncResult<SyncProject[]>> {
    const all: SyncProject[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let account: string | undefined;
    for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
      const path: string = cursor === null ? PROJECTS_PATH : `${PROJECTS_PATH}?cursor=${encodeURIComponent(cursor)}`;
      const res = await read(path, parseSidebar);
      if (!res.ok) return res;
      account = res.account;
      const fresh = res.data.projects.filter((p) => !seen.has(p.gizmoId));
      fresh.forEach((p) => seen.add(p.gizmoId));
      all.push(...fresh);
      cursor = fresh.length ? res.data.cursor : null; // 새 프로젝트가 없으면 같은 쪽을 되풀이하는 것이라 멈춘다
      if (cursor === null) break;
    }
    return done(account, all);
  }

  // 프로젝트 대화 목록: items[].id · items[].update_time 이 필수
  function parseProjectPage(json: unknown): SyncProjectPage | null {
    const body = asRecord(json);
    if (!body || !Array.isArray(body.items)) return null;
    const items: SyncConversationRef[] = [];
    for (const raw of body.items) {
      const item = asRecord(raw);
      const updateTime = isoOf(item?.update_time);
      if (!item || typeof item.id !== 'string' || !item.id || updateTime === null) return null;
      items.push({
        id: item.id,
        updateTime,
        isArchived: item.is_archived === true,
        gizmoId: typeof item.gizmo_id === 'string' ? item.gizmo_id : null,
      });
    }
    items.sort((a, b) => Date.parse(b.updateTime) - Date.parse(a.updateTime)); // update_time 최신 순 (같으면 받은 순서)
    return { items, nextCursor: items.length ? cursorOf(body.cursor) : null };
  }

  const projectPage = (gizmoId: string, cursor: string | null) => read(projectPagePath(gizmoId, cursor), parseProjectPage);

  async function conversation(id: string, windows: SyncWindow[]) {
    const { result, account } = await authedGet(conversationPath(id));
    if ('unauthorized' in result) return failed(fail('logged_out'), account);
    if (!result.ok) return failed(result, account);
    const body = asRecord(result.json);
    if (!body || !asRecord(body.mapping)) return failed(fail('shape_changed'), account);

    let normalized: ReturnType<typeof normalizeConversation>;
    try {
      normalized = normalizeConversation(body as RawConversation);
    } catch {
      return failed(fail('shape_changed'), account); // 연결 구조가 도는 등
    }
    const messages: CollectedMessage[] = [];
    for (const turn of turnsInWindows(normalized.turns, Array.isArray(windows) ? windows : [])) {
      for (const m of turn.messages) {
        if (m.createdAt === null) continue; // 시각 있는 턴만 남으므로 닿지 않는다
        messages.push({
          id: `chatgpt:${m.id}`,
          site: 'chatgpt',
          role: m.role,
          text: clipText(m.text),
          conversationId: id,
          collectedAt: m.createdAt, // 분류기가 이 값을 대화 시각으로 쓴다 (sync-contract 2장)
          createdAt: m.createdAt,
          origin: 'sync',
          turnId: turn.turnId,
        });
      }
    }
    const skippedNoTime = normalized.turns.filter((t) => t.complete && (t.start === null || t.end === null)).length;
    const data: SyncConversationData = { messages, inProgress: normalized.inProgress, skippedNoTime };
    return done(account, data);
  }

  return {
    async handle(request) {
      try {
        switch (request.type) {
          case 'sync.session':
            return await sessionCheck();
          case 'sync.projects':
            return await projects();
          case 'sync.projectPage':
            if (typeof request.gizmoId !== 'string' || !request.gizmoId) return fail('shape_changed');
            return await projectPage(request.gizmoId, typeof request.cursor === 'string' ? request.cursor : null);
          case 'sync.conversation':
            if (typeof request.id !== 'string' || !request.id) return fail('shape_changed');
            return await conversation(request.id, request.windows);
          default:
            return fail('shape_changed'); // 모르는 sync.* 요청
        }
      } catch {
        // 뜻밖의 예외(예: 해시 API 없음)는 일시 오류로 두면 조용히 되풀이되므로 고장으로 알린다
        return session ? { ...fail('shape_changed'), account: session.account } : fail('shape_changed');
      }
    },
  };
}
