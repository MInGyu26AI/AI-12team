import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { load } from './load-ts.mjs';

const auth = load('@/lib/onboarding-server');
process.env.SYNCUP_WEB_ORIGIN = 'http://localhost:3000';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://synthetic.supabase.co';
const request = (value, state) => new NextRequest(`http://localhost:3000/start/callback?flow=${state}`, {
  headers: { Cookie: `${auth.FLOW}=${value}` },
});

test('signup binds its callback to the cookie and PKCE, without putting verifier in the URL', () => {
  const flow = auth.beginFlow('시험 사용자');
  const stored = JSON.parse(Buffer.from(flow.value, 'base64url'));
  const url = new URL(flow.url);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(stored.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('provider'), 'github');
  assert.ok(!flow.url.includes(stored.verifier));
  const valid = auth.readFlow(request(flow.value, stored.state));
  assert.equal(valid.verifier, stored.verifier);
  assert.equal(valid.name, '시험 사용자');
  assert.throws(() => auth.readFlow(request(flow.value, 'x'.repeat(43))));
  stored.created -= 600001;
  assert.throws(() => auth.readFlow(request(Buffer.from(JSON.stringify(stored)).toString('base64url'), stored.state)));
});

test('writes require the exact origin; missing Origin is not accepted', () => {
  assert.equal(auth.sameOrigin(new Request('http://localhost:3000', { headers: { Origin: 'http://localhost:3000' } })), true);
  for (const origin of ['http://localhost:3001', 'https://evil.example']) {
    assert.equal(auth.sameOrigin(new Request('http://localhost:3000', { headers: { Origin: origin } })), false);
  }
  assert.equal(auth.sameOrigin(new Request('http://localhost:3000')), false);
});

test('bounded body reading also rejects oversized requests without Content-Length', async () => {
  const request = new Request('http://localhost:3000', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(9000) }) });
  await assert.rejects(auth.smallBody(request));
  assert.deepEqual(await auth.smallBody(new Request('http://localhost:3000', { method: 'POST', body: '{"name":"동균"}' })), { name: '동균' });
});

test('onboarding credential is HttpOnly, same-site and responses prohibit caching', () => {
  assert.equal(auth.cookieOptions.httpOnly, true);
  assert.equal(auth.cookieOptions.sameSite, 'lax');
  assert.equal(auth.json({ ok: true }).headers.get('Cache-Control'), 'no-store');
  assert.equal(auth.json({ ok: true }).headers.get('Referrer-Policy'), 'no-referrer');
});
