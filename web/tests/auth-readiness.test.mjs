import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load-ts.mjs';
import { validateProductionConfig } from '../release-config.cjs';

const { loginDestination, readAccount, connectionProblem, needsConsent, consentUrl, isConsentRefusal } = load('@/lib/auth-navigation');
const { TERMS_VERSION, PRIVACY_VERSION } = load('@/lib/legal');
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

const consented = { terms: TERMS_VERSION, privacy: PRIVACY_VERSION, at: '2026-11-16T09:00:00Z' };

test('consent is optional in the account, but a malformed record is refused', () => {
  // 옛 서버 응답(consent 없음)·미동의(null)·동의(객체) 모두 받는다
  assert.deepEqual(readAccount({ ...alice, consent: null }), { ...alice, consent: null });
  assert.deepEqual(readAccount({ ...alice, consent: consented }), { ...alice, consent: consented });
  for (const consent of ['yes', 7, [], {}, { terms: 'beta-0.1', privacy: 'beta-0.1' }, { terms: 1, privacy: 'beta-0.1', at: 'x' }, { ...consented, at: null }]) {
    assert.throws(() => readAccount({ ...alice, consent }), undefined, JSON.stringify(consent));
  }
});

test('an account must consent when the record is missing or the documents changed version', () => {
  assert.equal(needsConsent(alice), true); // 필드 없음
  assert.equal(needsConsent({ ...alice, consent: null }), true);
  assert.equal(needsConsent({ ...alice, consent: consented }), false);
  assert.equal(needsConsent({ ...alice, consent: { ...consented, terms: 'beta-0.0' } }), true);
  assert.equal(needsConsent({ ...alice, consent: { ...consented, privacy: 'beta-0.2' } }), true);
});

test('the consent screen only ever returns to a known internal destination', () => {
  assert.equal(consentUrl('/board'), '/signup/consent?next=%2Fboard');
  assert.equal(consentUrl('https://evil.test'), '/signup/consent?next=%2Fdashboard');
  assert.equal(consentUrl('/signup/consent'), '/signup/consent?next=%2Fdashboard'); // 동의 화면이 자기 자신으로 돌려보내지 않는다
  assert.equal(loginDestination('/signup/consent'), '/dashboard');
});

test('only the server consent refusal is shown with the consent link, not other 403s', () => {
  assert.equal(isConsentRefusal(403, '먼저 이용약관과 개인정보 처리방침에 동의해 주세요.'), true);
  assert.equal(isConsentRefusal(403, '이 사이트에서 다시 시도해 주세요.'), false);
  assert.equal(isConsentRefusal(409, '먼저 이용약관과 개인정보 처리방침에 동의해 주세요.'), false);
  assert.equal(isConsentRefusal(403, undefined), false);
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
