import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { load } from './load-ts.mjs';

process.env.SYNCUP_WEB_ORIGIN = 'http://localhost:3000';
process.env.SYNCUP_TEAM_API_URL = 'http://localhost:9000';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://synthetic.supabase.co';
const auth = load('@/lib/onboarding-server');
const account = load('@/app/api/onboarding/route');
const callback = load('@/app/start/callback/route');
const request = (method, cookie, origin = 'http://localhost:3000') => new NextRequest('http://localhost:3000/api/onboarding', {
  method, headers: { Origin: origin, ...(cookie ? { Cookie: `${auth.SESSION}=${cookie}` } : {}) },
});

test('unauthenticated and expired sessions cannot read an account; expiry removes its cookie', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: 'expired' }, { status: 401 }); });
  assert.equal((await account.GET(request('GET'))).status, 401);
  assert.equal(calls, 0);
  const expired = await account.GET(request('GET', 's'.repeat(43)));
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(calls, 1);
});

test('logout rejects a foreign origin and never claims success after upstream failure', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}, { status: 503 }); });
  assert.equal((await account.DELETE(request('DELETE', 's'.repeat(43), 'https://evil.test'))).status, 403);
  assert.equal(calls, 0);
  const failed = await account.DELETE(request('DELETE', 's'.repeat(43)));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('set-cookie'), null);
});

test('successful logout revokes the server session and removes the browser cookie', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'DELETE');
    assert.equal(options.headers.Authorization, `Bearer ${'s'.repeat(43)}`);
    return Response.json({ signed_out: true });
  });
  const response = await account.DELETE(request('DELETE', 's'.repeat(43)));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('GitHub callback consumes the bound flow, issues an HttpOnly session and returns to the intended route', async t => {
  const flow = auth.beginFlow(undefined, '/board/notion');
  const stored = JSON.parse(Buffer.from(flow.value, 'base64url'));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.verifier, stored.verifier);
    assert.equal(body.name, undefined);
    return Response.json({ session: 's'.repeat(43) });
  });
  const response = await callback.GET(new NextRequest(`http://localhost:3000/start/callback?flow=${stored.state}&code=11111111-1111-4111-8111-111111111111`, {
    headers: { Cookie: `${auth.FLOW}=${flow.value}` },
  }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'http://localhost:3000/board/notion');
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(response.cookies.get(auth.FLOW).value, '');
  assert.equal(response.cookies.get(auth.SESSION).value, 's'.repeat(43));
});

test('missing OAuth flow never reaches the upstream and clears an old browser session', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not reach upstream'); });
  const response = await callback.GET(new NextRequest('http://localhost:3000/start/callback?error=access_denied'));
  assert.equal(response.headers.get('location'), 'http://localhost:3000/login?error=login');
  assert.equal(response.cookies.get(auth.SESSION).value, '');
});
