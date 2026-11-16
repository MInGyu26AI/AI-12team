import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load-ts.mjs';
import { validateProductionConfig } from '../release-config.cjs';

const { loginDestination, readAccount, connectionProblem } = load('@/lib/auth-navigation');
const alice = { id: '11111111-1111-4111-8111-111111111111', name: '동명 사용자', teams: [{ id: 'team-a', name: '팀 A' }] };

test('OAuth return paths reject external, encoded and unsupported destinations', () => {
  for (const path of ['/dashboard', '/collect', '/review', '/board/repo', '/start', '/join/' + 'a'.repeat(43)]) assert.equal(loginDestination(path), path);
  // 로그인 뒤 기본 화면은 대시보드 (첫 로그인이면 그 위에 팀 만들기 팝업)
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/login', '/api/onboarding', '/collect?next=https://evil.test', null, 42]) assert.equal(loginDestination(path), '/dashboard');
});

test('a verified account, not the display name, must match the connected PC and team', () => {
  assert.deepEqual(readAccount(alice), alice);
  assert.throws(() => readAccount({ name: '동명 사용자', teams: [] }));
  assert.throws(() => readAccount({ ...alice, teams: [{ id: 'team-a' }] }));
  assert.equal(connectionProblem(alice, { userId: alice.id, teamId: 'team-a' }), null);
  assert.match(connectionProblem(alice, { userId: 'another-user', teamId: 'team-a' }), /계정이 달라/);
  assert.match(connectionProblem(alice, { userId: alice.id, teamId: 'team-b' }), /참여한 팀/);
  assert.match(connectionProblem(alice, { teamId: 'team-a' }), /업데이트/);
});

const production = { VERCEL_ENV: 'production', SYNCUP_WEB_ORIGIN: 'https://syncup-ashen.vercel.app',
  SYNCUP_TEAM_API_URL: 'https://syncup-api-production-36de.up.railway.app', NEXT_PUBLIC_SUPABASE_URL: 'https://gmwvivrmmzsrpdwdfeul.supabase.co' };
test('production refuses mock data, local bridge and mismatched login origins before publishing', () => {
  assert.doesNotThrow(() => validateProductionConfig(production));
  for (const key of ['NEXT_PUBLIC_USE_MOCK', 'NEXT_PUBLIC_DEMO_MODE', 'NEXT_PUBLIC_LOCAL_BRIDGE']) assert.throws(() => validateProductionConfig({ ...production, [key]: 'true' }));
  assert.throws(() => validateProductionConfig({ ...production, SYNCUP_CONNECTION_FILE: '/private/local.json' }));
  assert.throws(() => validateProductionConfig({ ...production, SYNCUP_WEB_ORIGIN: 'https://syncup-live-murex.vercel.app' }));
  assert.throws(() => validateProductionConfig({ ...production, NEXT_PUBLIC_SUPABASE_URL: '' }));
  assert.doesNotThrow(() => validateProductionConfig({ VERCEL_ENV: 'preview', NEXT_PUBLIC_USE_MOCK: 'true' }));
});
