// 마이페이지: lib/profile.ts 의 순수 함수와 /api/onboarding/profile·profile/photo·withdraw 웹 경로.
// 서버는 가짜 fetch 로 대신한다 (onboarding-consent.test.mjs 와 같은 방식)
import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { load } from './load-ts.mjs';

process.env.SYNCUP_WEB_ORIGIN = 'http://localhost:3000';
process.env.SYNCUP_TEAM_API_URL = 'http://localhost:9000';
const auth = load('@/lib/onboarding-server');
const lib = load('@/lib/profile');
const profileRoute = load('@/app/api/onboarding/profile/route');
const photoRoute = load('@/app/api/onboarding/profile/photo/route');
const withdrawRoute = load('@/app/api/onboarding/withdraw/route');
const SESSION = 's'.repeat(43);
const PROFILE = { name: '하늘', school: null, major: null, grade: null, role: null, photo: null, github_avatar: null, updated_at: null };
const INPUT = { name: '하늘', school: '한국대학교', major: '', grade: '3학년', role: '프론트엔드' };
const png = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;

const req = (path, method, body, { cookie = SESSION, origin = 'http://localhost:3000', raw } = {}) => new NextRequest(`http://localhost:3000/api/onboarding/${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: `${auth.SESSION}=${cookie}` } : {}) },
  ...(method === 'GET' || method === 'DELETE' ? {} : { body: raw ?? JSON.stringify(body) }),
});
const mockUpstream = (t, status, data, seen = []) => t.mock.method(globalThis, 'fetch', async (url, options) => {
  seen.push({ url, options });
  return Response.json(data, { status });
});

test('readProfile accepts the contract shape and rejects anything else', () => {
  assert.deepEqual(lib.readProfile({ ...PROFILE, extra: 1 }), PROFILE);
  assert.equal(lib.readProfile({ ...PROFILE, photo: 'data:image/webp;base64,AAAA', github_avatar: 'https://x.test/a.png', updated_at: '2026-11-16T00:00:00Z' }).photo, 'data:image/webp;base64,AAAA');
  for (const bad of [null, [], 'x', {}, { ...PROFILE, name: 3 }, { ...PROFILE, school: 4 }, { ...PROFILE, photo: 'https://x.test/a.png' }, { ...PROFILE, github_avatar: 1 }, { name: '하늘' }]) {
    assert.throws(() => lib.readProfile(bad), /프로필을 확인하지 못했어요/, JSON.stringify(bad));
  }
});

test('validateProfileInput follows the server limits and says why in Korean', () => {
  assert.equal(lib.validateProfileInput(INPUT), null);
  assert.equal(lib.validateProfileInput({ ...INPUT, grade: null }), null);
  assert.match(lib.validateProfileInput({ ...INPUT, name: '   ' }), /이름을 입력/);
  assert.match(lib.validateProfileInput({ ...INPUT, name: 'a'.repeat(41) }), /40자/);
  assert.equal(lib.validateProfileInput({ ...INPUT, name: 'a'.repeat(40) }), null);
  assert.match(lib.validateProfileInput({ ...INPUT, school: 'a'.repeat(61) }), /학교.*60자/);
  assert.match(lib.validateProfileInput({ ...INPUT, major: 'a'.repeat(61) }), /전공.*60자/);
  assert.match(lib.validateProfileInput({ ...INPUT, role: 'a'.repeat(81) }), /역할.*80자/);
  assert.equal(lib.validateProfileInput({ ...INPUT, role: 'a'.repeat(80) }), null);
  assert.match(lib.validateProfileInput({ ...INPUT, role: '한 줄\n두 줄' }), /한 줄로/);
  assert.match(lib.validateProfileInput({ ...INPUT, name: 'a\tb' }), /한 줄로/);
  assert.match(lib.validateProfileInput({ ...INPUT, grade: '6학년' }), /학년/);
  assert.deepEqual([...lib.GRADES], ['1학년', '2학년', '3학년', '4학년', '5학년 이상', '대학원', '기타']);
});

test('toProfileBody trims and turns empty text into null; initialOf, confirmsName, dates and versions', () => {
  assert.deepEqual(lib.toProfileBody({ ...INPUT, name: ' 하늘 ', school: '  ', major: ' 인공지능 ' }), { name: '하늘', school: null, major: '인공지능', grade: '3학년', role: '프론트엔드' });
  assert.equal(lib.initialOf('하늘'), '하');
  assert.equal(lib.initialOf('  Kim'), 'K');
  assert.equal(lib.initialOf('😀 fun'), '😀');
  assert.equal(lib.initialOf(''), '나');
  assert.equal(lib.initialOf(null), '나');
  assert.equal(lib.confirmsName('하늘', '하늘'), true);
  assert.equal(lib.confirmsName(' 하늘 ', '하늘'), true);
  assert.equal(lib.confirmsName('하', '하늘'), false);
  assert.equal(lib.confirmsName('', ''), false);
  assert.equal(lib.koreanDate('2026-11-16T09:00:00Z'), '2026. 11. 16.');
  assert.equal(lib.koreanDate('2026-11-15T16:00:00Z'), '2026. 11. 16.'); // 한국 시간 기준
  assert.equal(lib.koreanDate('nope'), '');
  assert.equal(lib.versionLabel('beta-0.1'), '베타 0.1');
  assert.equal(lib.versionLabel('1.0'), '1.0');
});

test('validatePhotoDataUrl: png/jpeg/webp only and at most 300,000 decoded bytes', () => {
  assert.equal(lib.validatePhotoDataUrl(png(1000)), null);
  assert.equal(lib.validatePhotoDataUrl(png(300000)), null);
  assert.match(lib.validatePhotoDataUrl(png(300001)), /너무 커요/);
  assert.match(lib.validatePhotoDataUrl('data:image/gif;base64,AAAA'), /PNG·JPG·WebP/);
  assert.match(lib.validatePhotoDataUrl('data:image/svg+xml;base64,AAAA'), /PNG·JPG·WebP/);
  assert.match(lib.validatePhotoDataUrl('data:text/html;base64,AAAA'), /PNG·JPG·WebP/);
  assert.match(lib.validatePhotoDataUrl('https://x.test/a.png'), /PNG·JPG·WebP/);
  assert.match(lib.validatePhotoDataUrl('data:image/png;base64,@@@'), /PNG·JPG·WebP/);
  assert.match(lib.validatePhotoDataUrl(42), /확인하지 못했어요/);
});

test('profile GET: forwards the session as bearer token, and an expired session clears the cookie', async t => {
  const seen = [];
  mockUpstream(t, 200, PROFILE, seen);
  const ok = await profileRoute.GET(req('profile', 'GET'));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), PROFILE);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/profile');
  assert.equal(seen[0].options.method, 'GET');
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  t.mock.restoreAll();
  mockUpstream(t, 401, { error: '로그인이 끝났어요.' });
  const expired = await profileRoute.GET(req('profile', 'GET'));
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('set-cookie'), /Max-Age=0/);
  t.mock.restoreAll();
  mockUpstream(t, 200, PROFILE);
  assert.equal((await profileRoute.GET(req('profile', 'GET', undefined, { cookie: '' }))).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('profile PUT: sends exactly the five trimmed fields; bad input never reaches the server', async t => {
  const seen = [];
  mockUpstream(t, 200, { ...PROFILE, ...INPUT }, seen);
  const ok = await profileRoute.PUT(req('profile', 'PUT', { ...INPUT, name: ' 하늘 ', major: '  ', is_admin: true, photo: png(10) }));
  assert.equal(ok.status, 200);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/profile');
  assert.equal(seen[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[0].options.body), { name: '하늘', school: '한국대학교', major: null, grade: '3학년', role: '프론트엔드' });
  t.mock.restoreAll();
  mockUpstream(t, 200, PROFILE);
  for (const body of [{ ...INPUT, name: '' }, { ...INPUT, name: 'a'.repeat(41) }, { ...INPUT, grade: '6학년' }, { ...INPUT, role: 'a'.repeat(81) },
    { ...INPUT, role: 'x\ny' }, { ...INPUT, school: 5 }, { school: 'x' }, [], 'yes', null]) {
    assert.equal((await profileRoute.PUT(req('profile', 'PUT', body))).status, 400, JSON.stringify(body));
  }
  assert.equal((await profileRoute.PUT(req('profile', 'PUT', INPUT, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await profileRoute.PUT(req('profile', 'PUT', INPUT, { cookie: '' }))).status, 401);
  assert.equal((await profileRoute.PUT(req('profile', 'PUT', INPUT, { raw: 'x'.repeat(9000) }))).status, 503); // 작은 본문 한도
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('profile PUT: server answers reach the screen unchanged; an unreachable server is not reported as saved', async t => {
  mockUpstream(t, 403, { error: '먼저 이용약관과 개인정보 처리방침에 동의해 주세요.' });
  const refused = await profileRoute.PUT(req('profile', 'PUT', INPUT));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /이용약관/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('down'); });
  assert.equal((await profileRoute.PUT(req('profile', 'PUT', INPUT))).status, 503);
});

test('photo PUT: checks type and size before forwarding, then sends only the image', async t => {
  const seen = [];
  mockUpstream(t, 200, PROFILE, seen);
  const image = png(200000); // 본문이 8KB 를 넘어도 이 경로는 받는다
  const ok = await photoRoute.PUT(req('profile/photo', 'PUT', { image, extra: 1 }));
  assert.equal(ok.status, 200);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/profile/photo');
  assert.equal(seen[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[0].options.body), { image });
  t.mock.restoreAll();
  mockUpstream(t, 200, PROFILE);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', { image: 'data:image/gif;base64,AAAA' }))).status, 400);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', { image: 'data:text/html;base64,PGI+' }))).status, 400);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', { image: png(300001) }))).status, 400);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', { image: 7 }))).status, 400);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', [], {}))).status, 400);
  const huge = await photoRoute.PUT(req('profile/photo', 'PUT', undefined, { raw: JSON.stringify({ image: png(400000) }) }));
  assert.equal(huge.status, 413);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', { image }, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await photoRoute.PUT(req('profile/photo', 'PUT', { image }, { cookie: '' }))).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('photo DELETE: same-origin session only, forwards a DELETE', async t => {
  const seen = [];
  mockUpstream(t, 200, PROFILE, seen);
  assert.equal((await photoRoute.DELETE(req('profile/photo', 'DELETE'))).status, 200);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/profile/photo');
  assert.equal(seen[0].options.method, 'DELETE');
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal((await photoRoute.DELETE(req('profile/photo', 'DELETE', undefined, { origin: '' }))).status, 403);
  assert.equal((await photoRoute.DELETE(req('profile/photo', 'DELETE', undefined, { cookie: '' }))).status, 401);
  assert.equal(seen.length, 1);
});

test('withdraw: sends the typed name, clears the session cookie only when the server deleted the account', async t => {
  const seen = [];
  mockUpstream(t, 200, { deleted: true }, seen);
  const done = await withdrawRoute.POST(req('withdraw', 'POST', { confirm: '하늘', extra: 1 }));
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { deleted: true });
  assert.match(done.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(seen[0].url, 'http://localhost:9000/onboarding/withdraw');
  assert.equal(seen[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].options.body), { confirm: '하늘' });
  t.mock.restoreAll();
  mockUpstream(t, 400, { error: '이름이 달라요.' });
  const wrong = await withdrawRoute.POST(req('withdraw', 'POST', { confirm: '다른이름' }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.headers.get('set-cookie'), null);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('down'); });
  const down = await withdrawRoute.POST(req('withdraw', 'POST', { confirm: '하늘' }));
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('set-cookie'), null);
});

test('withdraw: foreign origin, missing session and a missing or odd confirmation never reach the server', async t => {
  mockUpstream(t, 200, { deleted: true });
  assert.equal((await withdrawRoute.POST(req('withdraw', 'POST', { confirm: '하늘' }, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await withdrawRoute.POST(req('withdraw', 'POST', { confirm: '하늘' }, { cookie: '' }))).status, 401);
  for (const body of [{}, { confirm: '' }, { confirm: '   ' }, { confirm: 5 }, { confirm: 'a'.repeat(81) }, [], null, 'x']) {
    assert.equal((await withdrawRoute.POST(req('withdraw', 'POST', body))).status, 400, JSON.stringify(body));
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('after a login the allow-list brings the user back to /me', () => {
  const nav = load('@/lib/auth-navigation');
  assert.equal(nav.loginDestination('/me'), '/me');
  assert.equal(nav.loginDestination('/me/evil'), '/dashboard');
});
