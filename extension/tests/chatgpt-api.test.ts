// ChatGPT 탭 클라이언트(lib/sites/chatgpt-api.ts) 시험: 가짜 fetch 로만. 실제 chatgpt.com 에는 요청하지 않는다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SyncWindow } from '@shared/bridge';
import { clipText, createChatgptApi, isSyncRequest, MAX_MESSAGE_TEXT } from '@/lib/sites/chatgpt-api';

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/chatgpt/${name}`, import.meta.url)), 'utf8'));
const SESSION = fixture('session.json');
const { expectedAccount, ...SESSION_BODY } = SESSION;
const CONV_BASIC = fixture('conversation-basic.json');
const CONV_PROGRESS = fixture('conversation-in-progress.json');

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
const status = (code: number, headers: Record<string, string> = {}, body = '') => new Response(body, { status: code, headers });

interface Call {
  path: string;
  authorization: string | null;
}

/** 경로별 응답 대본으로 돌리는 가짜 fetch. 값이 함수면 부를 때마다 계산하고, 배열이면 부를 때마다 하나씩 꺼낸다 */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, authorization: new Headers(init?.headers).get('Authorization') });
    let route = routes[path] ?? routes[path.split('?')[0]!];
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0];
    if (typeof route === 'function') route = await route();
    if (route === undefined) throw new Error(`대본에 없는 요청: ${path}`);
    if (route instanceof Error) throw route;
    if (route instanceof Response) return route.clone();
    return typeof (route as { text?: unknown }).text === 'function' ? (route as Response) : json(route); // 본문 읽기 실패 시험용 가짜 응답은 그대로
  }) as typeof fetch;
  return { fetchFn, calls, paths: () => calls.map((c) => c.path) };
}

const ALL_TIME: SyncWindow[] = [{ start: '2025-01-01T00:00:00.000Z', end: '2030-01-01T00:00:00.000Z' }];
const OPEN_CONV = '/backend-api/conversation/c0ffee00-0000-4000-8000-000000000001';

const apiWith = (routes: Record<string, unknown>, now = () => Date.parse('2025-11-13T02:00:00Z')) => {
  const fake = fakeFetch({ '/api/auth/session': SESSION_BODY, ...routes });
  return { ...fake, api: createChatgptApi({ fetch: fake.fetchFn, now }) };
};

describe('isSyncRequest', () => {
  it('type 이 sync. 로 시작하는 메시지만 받는다', () => {
    expect(isSyncRequest({ type: 'sync.session' })).toBe(true);
    expect(isSyncRequest({ type: 'sync.conversation', id: 'x', windows: [] })).toBe(true);
    expect(isSyncRequest({ type: 'ping' })).toBe(false);
    expect(isSyncRequest({ type: 'toast', text: '' })).toBe(false);
    expect(isSyncRequest({ type: 'syncNow' })).toBe(false);
    expect(isSyncRequest({ type: 42 })).toBe(false);
    expect(isSyncRequest(null)).toBe(false);
    expect(isSyncRequest('sync.session')).toBe(false);
  });
});

describe('sync.session', () => {
  it('account = sha256(UTF-8(user.id)) 소문자 hex 이고 픽스처의 expectedAccount 와 같다', async () => {
    const { api, calls } = apiWith({});
    const res = await api.handle({ type: 'sync.session' });
    expect(res).toEqual({ ok: true, account: expectedAccount, data: null });
    expect(expectedAccount).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([{ path: '/api/auth/session', authorization: null }]);
  });

  it('accessToken 이 없으면 logged_out', async () => {
    const { api } = apiWith({ '/api/auth/session': {} });
    expect(await api.handle({ type: 'sync.session' })).toEqual({ ok: false, error: 'logged_out' });
  });

  it('accessToken 이 있는데 user.id 가 없거나 문자열이 아니면 shape_changed', async () => {
    const noUser = apiWith({ '/api/auth/session': { accessToken: 't' } });
    expect(await noUser.api.handle({ type: 'sync.session' })).toEqual({ ok: false, error: 'shape_changed' });
    const numeric = apiWith({ '/api/auth/session': { accessToken: 't', user: { id: 42 } } });
    expect(await numeric.api.handle({ type: 'sync.session' })).toEqual({ ok: false, error: 'shape_changed' });
  });

  it('호출할 때마다 다시 받는다 (계정 바뀜을 패스마다 확인하려고)', async () => {
    const { api, paths } = apiWith({});
    await api.handle({ type: 'sync.session' });
    await api.handle({ type: 'sync.session' });
    expect(paths()).toEqual(['/api/auth/session', '/api/auth/session']);
  });

  it('사용자가 바뀌면 account 도 바뀐다', async () => {
    const { api } = apiWith({
      '/api/auth/session': [SESSION_BODY, { ...SESSION_BODY, user: { id: 'user-other' } }],
    });
    const first = await api.handle({ type: 'sync.session' });
    const second = await api.handle({ type: 'sync.session' });
    expect(first.ok && second.ok && first.account !== second.account).toBe(true);
  });
});

describe('sync.projects', () => {
  const sidebar = (ids: string[], cursor: string | null) => ({
    items: ids.map((id) => ({ gizmo: { id, display: { name: `이름 ${id}` } }, conversations: { items: [], cursor: null } })),
    cursor,
  });

  it('사이드바에서 {gizmoId, name} 목록을 만들고 토큰을 Bearer 로 붙인다 (프로젝트는 items[].gizmo 에 바로 있다)', async () => {
    const { api, calls } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': fixture('projects-sidebar.json') });
    const res = await api.handle({ type: 'sync.projects' });
    expect(res).toEqual({
      ok: true,
      account: expectedAccount,
      data: [
        { gizmoId: 'g-p-00000000000000000000000000000001', name: 'AI-12team 해커톤' },
        { gizmoId: 'g-p-00000000000000000000000000000002', name: '개인 메모' },
      ],
    });
    expect(calls).toEqual([
      { path: '/api/auth/session', authorization: null },
      { path: '/backend-api/gizmos/snorlax/sidebar', authorization: 'Bearer synthetic-token-not-real' },
    ]);
  });

  it('옛 추정 모양(items[].gizmo.gizmo)은 shape_changed', async () => {
    const old = { items: [{ gizmo: { gizmo: { id: 'g-1', display: { name: 'x' } } } }], cursor: null };
    const { api } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': old });
    expect(await api.handle({ type: 'sync.projects' })).toEqual({ ok: false, error: 'shape_changed', account: expectedAccount });
  });

  it('토큰은 메모리에 두고 다음 요청에서 세션을 다시 받지 않는다', async () => {
    const { api, paths } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': fixture('projects-sidebar.json') });
    await api.handle({ type: 'sync.projects' });
    await api.handle({ type: 'sync.projects' });
    expect(paths().filter((p) => p === '/api/auth/session')).toHaveLength(1);
  });

  it('동시에 부르면 세션은 한 번만 받는다', async () => {
    const { api, paths } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': fixture('projects-sidebar.json') });
    await Promise.all([api.handle({ type: 'sync.projects' }), api.handle({ type: 'sync.projects' })]);
    expect(paths().filter((p) => p === '/api/auth/session')).toHaveLength(1);
  });

  it('세션의 expires 가 지나면 토큰을 다시 받는다', async () => {
    let clock = Date.parse('2025-11-13T02:00:00Z');
    const { api, paths } = apiWith(
      {
        '/api/auth/session': { ...SESSION_BODY, expires: '2025-11-13T03:00:00.000Z' },
        '/backend-api/gizmos/snorlax/sidebar': fixture('projects-sidebar.json'),
      },
      () => clock,
    );
    await api.handle({ type: 'sync.projects' });
    clock = Date.parse('2025-11-13T03:00:01Z');
    await api.handle({ type: 'sync.projects' });
    expect(paths().filter((p) => p === '/api/auth/session')).toHaveLength(2);
  });

  it('cursor 가 있으면 다음 쪽을 이어 읽고 같은 프로젝트는 한 번만 담는다', async () => {
    const { api, paths } = apiWith({
      '/backend-api/gizmos/snorlax/sidebar': [sidebar(['g-1', 'g-2'], 'next+1/='), sidebar(['g-2', 'g-3'], null)],
    });
    const res = await api.handle({ type: 'sync.projects' });
    expect(res.ok && (res.data as unknown as { gizmoId: string }[]).map((p) => p.gizmoId)).toEqual(['g-1', 'g-2', 'g-3']);
    expect(paths()).toContain('/backend-api/gizmos/snorlax/sidebar?cursor=next%2B1%2F%3D');
  });

  it('새 프로젝트가 없는 쪽이 오면 멈춘다 (같은 쪽 되풀이로 요청이 늘지 않게)', async () => {
    const { api, paths } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': sidebar(['g-1'], 'again') });
    const res = await api.handle({ type: 'sync.projects' });
    expect(res.ok && (res.data as unknown as unknown[]).length).toBe(1);
    expect(paths().filter((p) => p.startsWith('/backend-api/gizmos/snorlax/sidebar'))).toHaveLength(2);
  });

  it('둘째 쪽부터 실패하면 이미 받은 목록으로 마친다 (사이드바의 쪽 넘기기는 실측 전)', async () => {
    const { api } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': [sidebar(['g-1'], 'next'), status(400)] });
    const res = await api.handle({ type: 'sync.projects' });
    expect(res).toEqual({ ok: true, account: expectedAccount, data: [{ gizmoId: 'g-1', name: '이름 g-1' }] });
  });

  it('첫 쪽이 실패하면 그 오류를 그대로 돌려준다', async () => {
    const { api } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': status(429, { 'Retry-After': '10' }) });
    expect(await api.handle({ type: 'sync.projects' })).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 10, account: expectedAccount });
  });

  it.each([
    ['items 가 없음', {}],
    ['items 가 배열이 아님', { items: {} }],
    ['gizmo.id 가 없음', { items: [{ gizmo: { display: { name: 'x' } } }] }],
    ['display.name 이 없음', { items: [{ gizmo: { id: 'g-1', display: {} } }] }],
    ['display 가 없음', { items: [{ gizmo: { id: 'g-1' } }] }],
    ['id 가 문자열이 아님', { items: [{ gizmo: { id: 7, display: { name: 'x' } } }] }],
    ['gizmo 가 없음', { items: [{ conversations: {} }] }],
  ])('필수 필드가 어긋나면 shape_changed: %s', async (_name, body) => {
    const { api } = apiWith({ '/backend-api/gizmos/snorlax/sidebar': body });
    expect(await api.handle({ type: 'sync.projects' })).toEqual({ ok: false, error: 'shape_changed', account: expectedAccount });
  });
});

describe('sync.projectPage', () => {
  const GIZMO = 'g-p-00000000000000000000000000000001';
  const base = `/backend-api/gizmos/${GIZMO}/conversations`;
  const FIRST = `${base}?limit=50&owned_only=false`;
  const request = (cursor: string | null = null) => ({ type: 'sync.projectPage', gizmoId: GIZMO, cursor }) as const;

  it('목록을 {id, updateTime(ISO), isArchived, isTemporary, gizmoId} 로 바꾼다 (마이크로초 ISO 도 밀리초로)', async () => {
    const { api } = apiWith({ [base]: fixture('project-conversations.json') });
    const res = await api.handle(request());
    expect(res).toEqual({
      ok: true,
      account: expectedAccount,
      data: {
        items: [
          { id: 'c0ffee00-0000-4000-8000-000000000001', updateTime: '2025-11-13T01:10:00.500Z', isArchived: false, isTemporary: false, gizmoId: GIZMO },
          { id: 'c0ffee00-0000-4000-8000-000000000002', updateTime: '2025-11-13T01:03:22.000Z', isArchived: false, isTemporary: false, gizmoId: GIZMO },
          { id: 'c0ffee00-0000-4000-8000-000000000003', updateTime: '2025-11-12T09:00:00.000Z', isArchived: true, isTemporary: false, gizmoId: GIZMO },
        ],
        nextCursor: 'opaque-synthetic-cursor+/=2',
      },
    });
  });

  it('첫 쪽은 ?limit=50&owned_only=false 만, 다음 쪽은 &cursor=<이스케이프한 cursor> 를 붙인다', async () => {
    const { api, paths } = apiWith({ [base]: fixture('project-conversations.json') });
    await api.handle(request(null));
    await api.handle(request('opaque-synthetic-cursor+/=2'));
    await api.handle(request('a b/c'));
    expect(paths().filter((p) => p.startsWith(base))).toEqual([
      FIRST,
      `${FIRST}&cursor=opaque-synthetic-cursor%2B%2F%3D2`,
      `${FIRST}&cursor=a%20b%2Fc`,
    ]);
    expect(paths().some((p) => p.includes('cursor=0'))).toBe(false);
  });

  it('받은 cursor 를 다음 요청에 그대로 돌려 쓰면 같은 값이 된다 (왕복)', async () => {
    const cursor = 'ab+/=c d%e';
    const { api, paths } = apiWith({ [base]: { items: [{ id: 'x', update_time: 1762990000 }], cursor } });
    const first = await api.handle(request());
    expect(first.ok && (first.data as unknown as { nextCursor: string }).nextCursor).toBe(cursor);
    await api.handle(request(cursor));
    expect(decodeURIComponent(paths().at(-1)!.split('&cursor=')[1]!)).toBe(cursor);
  });

  it('받은 순서가 아니라 update_time 최신 순으로 돌려준다', async () => {
    const body = {
      items: [
        { id: 'old', update_time: 1762990000, is_archived: false },
        { id: 'new', update_time: '2025-11-13T05:00:00Z', is_archived: false },
      ],
      cursor: null,
    };
    const { api } = apiWith({ [base]: body });
    const res = await api.handle(request());
    expect(res.ok && (res.data as unknown as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('숫자(유닉스 초) update_time 도 ISO 로 바꾼다', async () => {
    const { api } = apiWith({ [base]: { items: [{ id: 'x', update_time: 1762995802.0 }], cursor: null } });
    const res = await api.handle(request());
    expect(res.ok && (res.data as unknown as { items: { updateTime: string }[] }).items[0]!.updateTime).toBe('2025-11-13T01:03:22.000Z');
  });

  it('gizmo_id 가 없으면 null, 보관·임시 표시는 true 일 때만 true', async () => {
    const body = {
      items: [
        { id: 'x', update_time: 1762990000 },
        { id: 'y', update_time: 1762990000, is_archived: 'yes', is_temporary_chat: 'yes' },
        { id: 'z', update_time: 1762990000, is_archived: true, is_temporary_chat: true },
      ],
      cursor: null,
    };
    const { api } = apiWith({ [base]: body });
    const res = await api.handle(request());
    expect(res.ok && (res.data as unknown as { items: unknown[] }).items).toEqual([
      { id: 'x', updateTime: '2025-11-12T23:26:40.000Z', isArchived: false, isTemporary: false, gizmoId: null },
      { id: 'y', updateTime: '2025-11-12T23:26:40.000Z', isArchived: false, isTemporary: false, gizmoId: null },
      { id: 'z', updateTime: '2025-11-12T23:26:40.000Z', isArchived: true, isTemporary: true, gizmoId: null },
    ]);
  });

  it('임시 채팅(is_temporary_chat)은 isTemporary=true 로 담는다 (거르는 일은 패스가 한다)', async () => {
    const body = { items: [{ id: 'tmp', update_time: 1762990000, is_temporary_chat: true, gizmo_id: GIZMO }], cursor: null };
    const { api } = apiWith({ [base]: body });
    const res = await api.handle(request());
    expect(res.ok && (res.data as unknown as { items: { isTemporary: boolean }[] }).items[0]!.isTemporary).toBe(true);
  });

  it('cursor 가 null 이면 끝이다 (nextCursor = null)', async () => {
    const { api } = apiWith({ [base]: { items: [{ id: 'x', update_time: 1762990000 }], cursor: null } });
    const res = await api.handle(request());
    expect(res.ok && (res.data as unknown as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  it('항목이 없으면 cursor 가 와도 끝으로 본다', async () => {
    const { api } = apiWith({ [base]: { items: [], cursor: 'whatever' } });
    const res = await api.handle(request());
    expect(res).toEqual({ ok: true, account: expectedAccount, data: { items: [], nextCursor: null } });
  });

  it.each([
    ['items 가 없음', { cursor: null }],
    ['id 가 없음', { items: [{ update_time: 1762990000 }], cursor: null }],
    ['update_time 이 없음', { items: [{ id: 'x' }], cursor: null }],
    ['update_time 을 읽을 수 없음', { items: [{ id: 'x', update_time: '어제' }], cursor: null }],
    ['update_time 이 숫자도 문자열도 아님', { items: [{ id: 'x', update_time: { sec: 1 } }], cursor: null }],
    ['cursor 가 없음', { items: [{ id: 'x', update_time: 1762990000 }] }],
    ['cursor 가 숫자', { items: [{ id: 'x', update_time: 1762990000 }], cursor: 2 }],
    ['cursor 가 객체', { items: [{ id: 'x', update_time: 1762990000 }], cursor: {} }],
  ])('필수 필드가 어긋나면 shape_changed: %s', async (_name, body) => {
    const { api } = apiWith({ [base]: body });
    expect(await api.handle(request())).toEqual({ ok: false, error: 'shape_changed', account: expectedAccount });
  });

  it('gizmoId 가 비어 있으면 요청하지 않고 shape_changed', async () => {
    const { api, calls } = apiWith({});
    expect(await api.handle({ type: 'sync.projectPage', gizmoId: '', cursor: null })).toEqual({ ok: false, error: 'shape_changed' });
    expect(calls).toEqual([]);
  });
});

describe('sync.conversation', () => {
  it('창 안의 완료 턴을 CollectedMessage 로 바꾼다 (chatgpt: 접두사, origin=sync, collectedAt = createdAt)', async () => {
    const { api, paths } = apiWith({ [OPEN_CONV]: CONV_BASIC });
    const res = await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME });
    expect(paths()).toContain(OPEN_CONV);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as unknown as { messages: Record<string, unknown>[]; inProgress: boolean; inProgressAt: string | null; skippedNoTime: number };
    expect(data.inProgress).toBe(false);
    expect(data.inProgressAt).toBeNull();
    expect(data.skippedNoTime).toBe(0);
    expect(data.messages.map((m) => m.id)).toEqual(['chatgpt:m-u1', 'chatgpt:m-a1', 'chatgpt:m-a1b', 'chatgpt:m-u2', 'chatgpt:m-a2', 'chatgpt:m-u3', 'chatgpt:m-a3']);
    expect(data.messages[0]).toEqual({
      id: 'chatgpt:m-u1',
      site: 'chatgpt',
      role: 'user',
      text: '발표 자료 마감을 금요일로 정할까?',
      conversationId: 'c0ffee00-0000-4000-8000-000000000001',
      collectedAt: '2025-11-13T01:00:01.200Z',
      createdAt: '2025-11-13T01:00:01.200Z',
      origin: 'sync',
      turnId: 'm-u1',
    });
    for (const m of data.messages) {
      expect(m.collectedAt).toBe(m.createdAt);
      expect(m).not.toHaveProperty('conversationTitle'); // 제목은 탭 밖으로 내보내지 않는다
    }
    // turnId 는 그 턴의 사용자 메시지 id (접두사 없음)
    expect(data.messages.map((m) => m.turnId)).toEqual(['m-u1', 'm-u1', 'm-u1', 'm-u2', 'm-u2', 'm-u3', 'm-u3']);
  });

  it('창 밖의 턴과 두 조각에 걸친 턴은 담지 않는다', async () => {
    const { api } = apiWith({ [OPEN_CONV]: CONV_BASIC });
    const windows: SyncWindow[] = [
      { start: '2025-11-13T01:00:00.000Z', end: '2025-11-13T01:05:00.000Z' }, // 턴 1만
      { start: '2025-11-13T01:09:00.000Z', end: '2025-11-13T01:09:55.000Z' }, // 턴 3의 끝(01:09:55)이 창 끝과 같아 빠진다
    ];
    const res = await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows });
    expect(res.ok && (res.data as unknown as { messages: { turnId: string }[] }).messages.map((m) => m.turnId)).toEqual(['m-u1', 'm-u1', 'm-u1']);
  });

  it('창이 없으면 메시지는 없다 (inProgress·inProgressAt 은 창과 상관없이 알린다)', async () => {
    const { api } = apiWith({ [OPEN_CONV]: CONV_BASIC });
    const res = await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: [] });
    expect(res).toEqual({ ok: true, account: expectedAccount, data: { messages: [], inProgress: false, inProgressAt: null, skippedNoTime: 0 } });
  });

  it('도구 호출 노드가 완료 표시를 달아도 최종 답이 생성 중이면 그 턴을 빼고 inProgress=true (in-progress 픽스처)', async () => {
    const id = 'c0ffee00-0000-4000-8000-000000000002';
    const { api } = apiWith({ [`/backend-api/conversation/${id}`]: CONV_PROGRESS });
    const res = await api.handle({ type: 'sync.conversation', id, windows: ALL_TIME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as unknown as { messages: { id: string }[]; inProgress: boolean; inProgressAt: string | null };
    expect(data.inProgress).toBe(true);
    expect(data.inProgressAt).toBe('2025-11-13T01:03:22.000Z'); // 미완료 턴의 가장 늦은 메시지 시각
    expect(data.messages.map((m) => m.id)).toEqual(['chatgpt:p-u1', 'chatgpt:p-a1']);
  });

  it('create_time 이 없어 뺀 완료 턴을 skippedNoTime 으로 센다', async () => {
    const conv = structuredClone(CONV_BASIC);
    conv.mapping['m-a2'].message.create_time = null; // 턴 2
    const { api } = apiWith({ [OPEN_CONV]: conv });
    const res = await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as unknown as { messages: { turnId: string }[]; skippedNoTime: number };
    expect(data.skippedNoTime).toBe(1);
    expect([...new Set(data.messages.map((m) => m.turnId))]).toEqual(['m-u1', 'm-u3']);
  });

  it('대화 id 는 주소에서 이스케이프한다', async () => {
    const { api, paths } = apiWith({ '/backend-api/conversation/a%2Fb': CONV_BASIC });
    await api.handle({ type: 'sync.conversation', id: 'a/b', windows: ALL_TIME });
    expect(paths()).toContain('/backend-api/conversation/a%2Fb');
  });

  it('mapping 이 없거나 객체가 아니면 shape_changed', async () => {
    for (const body of [{}, { mapping: [] }, { mapping: null }, [1, 2]]) {
      const { api } = apiWith({ [OPEN_CONV]: body });
      expect(await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME })).toEqual({
        ok: false,
        error: 'shape_changed',
        account: expectedAccount,
      });
    }
  });

  it('normalizeConversation 이 던진 Error(연결 순환)도 shape_changed', async () => {
    const conv = structuredClone(CONV_BASIC);
    conv.mapping['m-u1'].parent = 'm-a3'; // 순환
    const { api } = apiWith({ [OPEN_CONV]: conv });
    expect(await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME })).toEqual({
      ok: false,
      error: 'shape_changed',
      account: expectedAccount,
    });
  });

  it('id 가 없으면 요청하지 않고 shape_changed', async () => {
    const { api, calls } = apiWith({});
    expect(await api.handle({ type: 'sync.conversation', id: '', windows: ALL_TIME })).toEqual({ ok: false, error: 'shape_changed' });
    expect(calls).toEqual([]);
  });
});

describe('본문 길이', () => {
  it('20000자 이하는 그대로', () => {
    const exact = 'a'.repeat(MAX_MESSAGE_TEXT);
    expect(clipText(exact)).toBe(exact);
  });

  it('20000자를 넘으면 19999자까지 남기고 끝에 … 을 붙인다', () => {
    const clipped = clipText('가'.repeat(MAX_MESSAGE_TEXT + 1));
    expect(clipped).toHaveLength(MAX_MESSAGE_TEXT);
    expect(clipped).toBe(`${'가'.repeat(MAX_MESSAGE_TEXT - 1)}…`);
  });

  it('서러게이트 쌍(이모지)이 경계에 걸리면 한 글자 덜 남긴다', () => {
    const text = `${'a'.repeat(MAX_MESSAGE_TEXT - 2)}😀뒤에 더 있음`; // 😀 의 앞 반쪽이 19999번째 자리
    const clipped = clipText(text);
    expect(clipped).toBe(`${'a'.repeat(MAX_MESSAGE_TEXT - 2)}…`);
    expect(clipped.isWellFormed()).toBe(true);
  });

  it('sync.conversation 의 긴 답변도 잘려서 나온다', async () => {
    const conv = structuredClone(CONV_BASIC);
    conv.mapping['m-a3'].message.content.parts = ['나'.repeat(25000)];
    const { api } = apiWith({ [OPEN_CONV]: conv });
    const res = await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const last = (res.data as unknown as { messages: { text: string }[] }).messages.at(-1)!;
    expect(last.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(last.text.endsWith('…')).toBe(true);
  });
});

describe('오류 분류', () => {
  const GIZMO = 'g-p-00000000000000000000000000000001';
  const page = `/backend-api/gizmos/${GIZMO}/conversations`;
  const pageRequest = { type: 'sync.projectPage', gizmoId: GIZMO, cursor: null } as const;

  it('429 는 rate_limited 이고 Retry-After 초를 retryAfterSec 에 넣는다', async () => {
    const { api } = apiWith({ [page]: status(429, { 'Retry-After': '120' }) });
    expect(await api.handle(pageRequest)).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 120, account: expectedAccount });
  });

  it('Retry-After 가 HTTP 날짜여도 남은 초로 바꾼다', async () => {
    const { api } = apiWith({ [page]: status(429, { 'Retry-After': 'Thu, 13 Nov 2025 02:05:00 GMT' }) }, () => Date.parse('2025-11-13T02:00:00Z'));
    expect(await api.handle(pageRequest)).toMatchObject({ ok: false, error: 'rate_limited', retryAfterSec: 300 });
  });

  it.each([[''], ['abc'], ['0'], ['-5']])('Retry-After 가 %j 이면 retryAfterSec 은 없다', async (value) => {
    const { api } = apiWith({ [page]: status(429, value ? { 'Retry-After': value } : {}) });
    const res = await api.handle(pageRequest);
    expect(res).toEqual({ ok: false, error: 'rate_limited', account: expectedAccount });
    expect(res).not.toHaveProperty('retryAfterSec');
  });

  it('403 은 forbidden', async () => {
    const { api } = apiWith({ [page]: status(403) });
    expect(await api.handle(pageRequest)).toEqual({ ok: false, error: 'forbidden', account: expectedAccount });
  });

  it('403 봇 확인 HTML 도 forbidden', async () => {
    const html = '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>';
    const { api } = apiWith({ [page]: status(403, { 'Content-Type': 'text/html' }, html) });
    expect(await api.handle(pageRequest)).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('200 인데 HTML 이면(봇 확인 화면) forbidden', async () => {
    const byHeader = apiWith({ [page]: status(200, { 'Content-Type': 'text/html; charset=utf-8' }, '<html>확인</html>') });
    expect(await byHeader.api.handle(pageRequest)).toMatchObject({ ok: false, error: 'forbidden' });
    const byBody = apiWith({ [page]: status(200, {}, '<!doctype html><title>x</title>') });
    expect(await byBody.api.handle(pageRequest)).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('200 인데 JSON 이 아니고 HTML 도 아니면 shape_changed', async () => {
    const { api } = apiWith({ [page]: status(200, {}, '이상한 응답') });
    expect(await api.handle(pageRequest)).toMatchObject({ ok: false, error: 'shape_changed' });
  });

  it('404 는 not_found', async () => {
    const { api } = apiWith({ [OPEN_CONV]: status(404) });
    expect(await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME })).toEqual({
      ok: false,
      error: 'not_found',
      account: expectedAccount,
    });
  });

  it.each([[500], [502], [503], [408]])('%i 는 network', async (code) => {
    const { api } = apiWith({ [page]: status(code) });
    expect(await api.handle(pageRequest)).toEqual({ ok: false, error: 'network', account: expectedAccount });
  });

  it('fetch 가 던지면 network', async () => {
    const { api } = apiWith({ [page]: new TypeError('Failed to fetch') });
    expect(await api.handle(pageRequest)).toEqual({ ok: false, error: 'network', account: expectedAccount });
  });

  it('응답 본문을 읽다 실패해도 network', async () => {
    const broken = { status: 200, ok: true, headers: new Headers(), clone() { return this; }, text: () => Promise.reject(new TypeError('reset')) };
    const { api } = apiWith({ [page]: () => broken });
    expect(await api.handle(pageRequest)).toMatchObject({ ok: false, error: 'network' });
  });

  it('그 밖의 4xx(400 등)는 주소나 규칙이 바뀐 것으로 보고 shape_changed', async () => {
    const { api } = apiWith({ [page]: status(400) });
    expect(await api.handle(pageRequest)).toMatchObject({ ok: false, error: 'shape_changed' });
  });

  it('세션을 받다가 생긴 오류도 같은 분류로 돌려준다', async () => {
    const limited = apiWith({ '/api/auth/session': status(429, { 'Retry-After': '30' }) });
    expect(await limited.api.handle(pageRequest)).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 30 });
    const down = apiWith({ '/api/auth/session': new TypeError('Failed to fetch') });
    expect(await down.api.handle({ type: 'sync.session' })).toEqual({ ok: false, error: 'network' });
    const forbidden = apiWith({ '/api/auth/session': status(403) });
    expect(await forbidden.api.handle({ type: 'sync.projects' })).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('401 이면 토큰을 한 번 다시 받는다', () => {
  const GIZMO = 'g-p-00000000000000000000000000000001';
  const page = `/backend-api/gizmos/${GIZMO}/conversations`;
  const firstPage = `${page}?limit=50&owned_only=false`;
  const pageRequest = { type: 'sync.projectPage', gizmoId: GIZMO, cursor: null } as const;
  const listing = fixture('project-conversations.json');

  it('새 토큰으로 한 번 다시 시도해 성공하면 그 결과를 돌려준다', async () => {
    const { api, calls } = apiWith({
      '/api/auth/session': [SESSION_BODY, { ...SESSION_BODY, accessToken: 'second-token' }],
      [page]: [status(401), listing],
    });
    const res = await api.handle(pageRequest);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { path: '/api/auth/session', authorization: null },
      { path: firstPage, authorization: 'Bearer synthetic-token-not-real' },
      { path: '/api/auth/session', authorization: null },
      { path: firstPage, authorization: 'Bearer second-token' },
    ]);
  });

  it('그래도 401 이면 logged_out (더 시도하지 않는다)', async () => {
    const { api, paths } = apiWith({ [page]: status(401) });
    expect(await api.handle(pageRequest)).toEqual({ ok: false, error: 'logged_out', account: expectedAccount });
    expect(paths()).toEqual(['/api/auth/session', firstPage, '/api/auth/session', firstPage]);
  });

  it('다시 받은 세션에 토큰이 없으면 logged_out', async () => {
    const { api } = apiWith({ '/api/auth/session': [SESSION_BODY, {}], [page]: status(401) });
    expect(await api.handle(pageRequest)).toEqual({ ok: false, error: 'logged_out' });
  });

  it('다시 받다가 429 면 rate_limited', async () => {
    const { api } = apiWith({ '/api/auth/session': [SESSION_BODY, status(429, { 'Retry-After': '60' })], [page]: status(401) });
    expect(await api.handle(pageRequest)).toMatchObject({ ok: false, error: 'rate_limited', retryAfterSec: 60 });
  });

  it('다시 받은 뒤에는 새 토큰을 메모리에 두고 다음 요청에 쓴다', async () => {
    const { api, calls } = apiWith({
      '/api/auth/session': [SESSION_BODY, { ...SESSION_BODY, accessToken: 'second-token' }],
      [page]: [status(401), listing, listing],
    });
    await api.handle(pageRequest);
    await api.handle(pageRequest);
    expect(calls.at(-1)).toEqual({ path: firstPage, authorization: 'Bearer second-token' });
    expect(calls.filter((c) => c.path === '/api/auth/session')).toHaveLength(2);
  });
});

describe('밖으로 내보내지 않는 것', () => {
  it('응답에 원본 JSON·제목·토큰이 들어 있지 않다', async () => {
    const { api } = apiWith({ [OPEN_CONV]: CONV_BASIC, '/backend-api/gizmos/snorlax/sidebar': fixture('projects-sidebar.json') });
    const responses = [
      await api.handle({ type: 'sync.session' }),
      await api.handle({ type: 'sync.projects' }),
      await api.handle({ type: 'sync.conversation', id: 'c0ffee00-0000-4000-8000-000000000001', windows: ALL_TIME }),
    ];
    const text = JSON.stringify(responses);
    expect(text).not.toContain('synthetic-token-not-real');
    expect(text).not.toContain('합성 대화'); // 대화 제목
    expect(text).not.toContain('user-synthetic0001'); // 사용자 id 는 해시로만
    expect(text).not.toContain('mapping');
  });
});
