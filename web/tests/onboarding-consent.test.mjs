// 약관 동의(/api/onboarding/consent)와 동의하지 않고 나가기(/api/onboarding/decline) 웹 경로.
// teams 경로와 같은 보안 틀: 같은 사이트 요청만, 세션 쿠키 필요, 작은 본문, 캐시 금지. 서버는 가짜 fetch 로 대신한다
import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { load } from './load-ts.mjs';

process.env.SYNCUP_WEB_ORIGIN = 'http://localhost:3000';
process.env.SYNCUP_TEAM_API_URL = 'http://localhost:9000';
const auth = load('@/lib/onboarding-server');
const consent = load('@/app/api/onboarding/consent/route');
const decline = load('@/app/api/onboarding/decline/route');
const { CONSENT_BODY } = load('@/lib/legal');
const SESSION = 's'.repeat(43);

const post = (path, body, { cookie = SESSION, origin = 'http://localhost:3000' } = {}) => new NextRequest(`http://localhost:3000/api/onboarding/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: `${auth.SESSION}=${cookie}` } : {}) },
  body: JSON.stringify(body),
});
const mockUpstream = (t, status, data, seen = []) => t.mock.method(globalThis, 'fetch', async (url, options) => {
  seen.push({ url, options });
  return Response.json(data, { status });
});

test('consent: the web sends exactly the four agreed fields with the session as bearer token', async t => {
  const seen = [];
  mockUpstream(t, 200, { id: 'x', consent: { terms: 'beta-0.1', privacy: 'beta-0.1', at: '2026-11-16T09:00:00Z' } }, seen);
  const response = await consent.POST(post('consent', { ...CONSENT_BODY, extra: 'dropped', is_admin: true }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).consent.terms, 'beta-0.1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/consent');
  assert.equal(seen[0].options.method, 'POST');
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${SESSION}`);
  assert.deepEqual(JSON.parse(seen[0].options.body), { terms: 'beta-0.1', privacy: 'beta-0.1', age14: true, transfer: true });
});

test('consent: foreign origin, missing origin and missing session never reach the server', async t => {
  mockUpstream(t, 200, {});
  assert.equal((await consent.POST(post('consent', CONSENT_BODY, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await consent.POST(post('consent', CONSENT_BODY, { origin: '' }))).status, 403);
  assert.equal((await consent.POST(post('consent', CONSENT_BODY, { cookie: '' }))).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('consent: an incomplete or malformed agreement is refused before the server', async t => {
  mockUpstream(t, 200, {});
  for (const body of [{ ...CONSENT_BODY, age14: false }, { ...CONSENT_BODY, transfer: 'true' }, { terms: 'beta-0.1', privacy: 'beta-0.1', age14: true },
    { ...CONSENT_BODY, terms: 'BETA 0.1' }, { ...CONSENT_BODY, privacy: 'x'.repeat(40) }, [], 'yes', null]) {
    assert.equal((await consent.POST(post('consent', body))).status, 400, JSON.stringify(body));
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('consent: the server answers (changed documents 409, expired session 401) reach the screen unchanged', async t => {
  mockUpstream(t, 409, { error: '약관이 바뀌었어요. 화면을 새로고침해 다시 확인해 주세요.' });
  const changed = await consent.POST(post('consent', CONSENT_BODY));
  assert.equal(changed.status, 409);
  assert.match((await changed.json()).error, /약관이 바뀌었어요/);
  t.mock.restoreAll();
  mockUpstream(t, 401, { error: '로그인이 끝났어요.' });
  assert.equal((await consent.POST(post('consent', CONSENT_BODY))).status, 401);
});

test('consent: an unreachable server is reported without pretending it was recorded', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('down'); });
  const response = await consent.POST(post('consent', CONSENT_BODY));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('decline: deleting the new account also removes the browser session cookie', async t => {
  const seen = [];
  mockUpstream(t, 200, { deleted: true }, seen);
  const response = await decline.POST(post('decline', {}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/decline');
  assert.deepEqual(JSON.parse(seen[0].options.body), {});
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${SESSION}`);
});

test('decline: a refused deletion (already consented or has teams) keeps the session and shows the server message', async t => {
  mockUpstream(t, 409, { error: '이미 동의했거나 팀이 있는 계정은 여기서 지울 수 없어요.' });
  const response = await decline.POST(post('decline', {}));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /지울 수 없어요/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('decline: a success that does not say deleted keeps the session; foreign origin and no session never reach the server', async t => {
  mockUpstream(t, 200, { ok: true });
  assert.equal((await decline.POST(post('decline', {}))).headers.get('set-cookie'), null);
  assert.equal((await decline.POST(post('decline', {}, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await decline.POST(post('decline', {}, { cookie: '' }))).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});
