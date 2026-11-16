"""Self-service signup/team creation on isolated real PostgreSQL and fake Supabase. No production connections."""
import repo_paths  # noqa: F401
import concurrent.futures
import hashlib
import json
import secrets
import time
import unittest
import uuid

import psycopg
from psycopg.types.json import Jsonb

from check_teams import TeamIsolation, own_tests, request
from fake_supabase import fake_supabase, github_user, challenge_of, PROVIDER_TOKEN
from key_issue import KeyIssuer
from team_access import verify_database
import onboarding


class Onboarding(TeamIsolation):
    def setUp(self):
        super().setUp()
        self.supabase = self.enterContext(fake_supabase())
        self.api.key_issuer = KeyIssuer(self.supabase.url, self.supabase.key)
        self.identity = github_user(int(uuid.uuid4().hex[:12], 16), 'synthetic')

    def call(self, method, path='/onboarding', token=None, data=None):
        status, raw = request(self.api, method, path, token, data)
        return status, json.loads(raw)

    def login(self, user=None, name='새 사용자'):
        verifier = secrets.token_urlsafe(48)
        code = self.supabase.login(challenge_of(verifier), user or self.identity)
        return self.call('POST', '/onboarding/login', data=dict(code=code, verifier=verifier, name=name))

    def consent(self, token, **change):
        return self.call('POST', '/onboarding/consent', token,
                         dict(dict(terms='beta-0.1', privacy='beta-0.1', age14=True, transfer=True), **change))

    def team(self, token, request_id=None, name='새 팀', consent=True):
        if consent and len(token) == 43:
            self.consent(token)  # same versions again keep the first agreed_at
        return self.call('POST', '/onboarding/teams', token,
                         dict(request_id=request_id or str(uuid.uuid4()), name=name, topic='합성 프로젝트'))

    def test_new_user_creates_team_and_can_get_a_native_key(self):
        status, signed = self.login()
        self.assertEqual(status, 200)
        token = signed['session']
        self.assertNotIn(PROVIDER_TOKEN, json.dumps(signed))
        self.assertTrue(self.supabase.logged_out)
        self.assertEqual(self.call('GET', token=token)[1]['teams'], [])
        self.assertRegex(self.call('GET', token=token)[1]['id'], r'^[0-9a-f-]{36}$')
        status, team = self.team(token)
        self.assertEqual(status, 200)
        self.assertEqual(self.call('GET', token=token)[1]['teams'], [dict(id=team['id'], name='새 팀')])
        self.assertEqual(request(self.api, 'GET', '/me', token)[0], 401)  # never a collector credential
        verifier = secrets.token_urlsafe(48)
        code = self.supabase.login(challenge_of(verifier), self.identity)
        raw_key = secrets.token_urlsafe(32)
        status, issued = self.call('POST', '/keys', data=dict(code=code, verifier=verifier,
            digest=hashlib.sha256(raw_key.encode()).hexdigest(), device='macOS'))
        self.assertEqual(status, 200)
        self.assertEqual(issued['name'], '새 사용자')
        self.assertEqual(request(self.api, 'GET', '/teams/'+team['id']+'/settings', raw_key)[0], 200)

    def test_relogin_keeps_name_and_does_not_duplicate_identity(self):
        first = self.login()[1]['session']
        created = self.team(first)[1]
        second = self.login(name='바뀌면 안 되는 이름')[1]['session']
        account = self.call('GET', token=second)[1]
        self.assertEqual(account['name'], '새 사용자')
        self.assertEqual(account['teams'][0]['id'], created['id'])

    def test_parallel_signup_and_invite_share_one_identity(self):
        code_hash = secrets.token_hex(32)
        with psycopg.connect(self.api_dsn) as c:
            c.execute("SELECT set_config('syncup.user_id', %s, true)", (self.users['Alice'],))
            invite = c.execute('SELECT o_outcome FROM syncup.create_invite(%s, %s)',
                               (self.teams['A'], code_hash)).fetchone()[0]
        self.assertEqual(invite, 'created')

        for signup_first in (True, False):
            with self.subTest(signup_first=signup_first):
                subject = str(int(uuid.uuid4().hex[:12], 16))
                session = secrets.token_hex(32)
                identities = Jsonb([dict(provider='github', subject=subject)])

                def signup(c):
                    result = c.execute('SELECT syncup.open_onboarding(%s, %s, %s, %s)',
                                       (subject, secrets.token_hex(32), session, '합성 사용자')).fetchone()[0]
                    return result['outcome']

                def join(c):
                    return c.execute('''SELECT o_outcome, o_user_id FROM
                        syncup.join_with_invite(%s, %s, %s, %s, NULL, 'macOS', '합성 사용자')''',
                        (code_hash, identities, secrets.token_hex(32), secrets.token_hex(32))).fetchone()

                def second_request(action):
                    with psycopg.connect(self.api_dsn, application_name='syncup-onboarding-race') as c:
                        c.execute("SET LOCAL statement_timeout = '10s'")
                        return action(c)

                # Hold whichever route ran first open until the other is blocked in PostgreSQL.
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool, \
                        psycopg.connect(self.api_dsn) as first, \
                        psycopg.connect(self.admin_dsn, autocommit=True) as observer:
                    first_action, second_action = (signup, join) if signup_first else (join, signup)
                    first_result = first_action(first)
                    second = pool.submit(second_request, second_action)
                    waiting = None
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        waiting = observer.execute('''SELECT wait_event FROM pg_stat_activity
                            WHERE application_name='syncup-onboarding-race' AND wait_event_type='Lock' ''').fetchone()
                        if waiting:
                            break
                        time.sleep(.05)
                    first.commit()
                    self.assertEqual(waiting, ('advisory',))
                    second_result = second.result(timeout=5)
                    signed, joined = (first_result, second_result) if signup_first else (second_result, first_result)
                    self.assertEqual(signed, 'ready')
                    self.assertEqual(joined[0], 'joined')
                    user = observer.execute('SELECT user_id FROM syncup.onboarding_sessions WHERE digest=%s',
                                            (session,)).fetchone()[0]
                    self.assertEqual(user, joined[1])

    def test_team_creation_is_idempotent_and_serialized_at_limit(self):
        token = self.login()[1]['session']
        rid = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.team(token, rid), range(4)))
        self.assertTrue(all(s == 200 for s, _ in results))
        self.assertEqual(len({r['id'] for _, r in results}), 1)
        self.assertEqual(self.team(token, rid, '다른 이름')[0], 409)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.team(token), range(4)))
        self.assertEqual(sum(s == 200 for s, _ in results), 2)
        self.assertEqual(sum(s == 409 for s, _ in results), 2)

    def test_sessions_expire_logout_and_inactive_users_cannot_write(self):
        token = self.login()[1]['session']
        self.assertEqual(self.call('DELETE', token=token)[0], 200)
        self.assertEqual(self.team(token)[0], 401)
        token = self.login()[1]['session']
        with psycopg.connect(self.admin_dsn) as c:
            c.execute("UPDATE syncup.onboarding_sessions SET expires_at=now()-interval '1 second' WHERE digest=%s", (onboarding.digest(token),))
        self.assertEqual(self.call('GET', token=token)[0], 401)
        token = self.login()[1]['session']
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('UPDATE syncup.users SET active=false WHERE id=(SELECT user_id FROM syncup.onboarding_sessions WHERE digest=%s)', (onboarding.digest(token),))
        self.assertEqual(self.team(token)[0], 401)
        self.assertEqual(self.login()[0], 403)

    def test_no_cross_user_access_or_token_privilege_confusion(self):
        alice = self.login()[1]['session']
        self.team(alice)
        bob = self.login(github_user(9991002, 'other'))[1]['session']
        self.assertEqual(self.call('GET', token=bob)[1]['teams'], [])
        self.assertEqual(self.call('GET', token=self.tokens['Alice'])[0], 401)
        self.assertEqual(self.call('GET')[0], 401)
        self.assertEqual(self.team(secrets.token_urlsafe(32))[0], 401)
        with psycopg.connect(self.api_dsn) as c:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                c.execute('SELECT * FROM syncup.onboarding_sessions')
        verify_database(self.api_dsn, web_keys=True)

    def test_bad_pkce_and_metadata_cannot_claim_identity(self):
        verifier = secrets.token_urlsafe(48)
        code = self.supabase.login(challenge_of(verifier), self.identity)
        self.assertEqual(self.call('POST', '/onboarding/login', data=dict(code=code, verifier='x'*64, name='x'))[0], 401)
        forged = github_user(9991003, 'forged', identities=[], user_metadata={'provider_id': self.identity['identities'][0]['id']})
        self.assertEqual(self.login(forged)[0], 403)
        status, _ = self.login(name='\ninvalid')
        self.assertEqual(status, 400)

    def test_one_click_login_uses_provider_name_only_as_display_and_keeps_existing_name(self):
        verifier = secrets.token_urlsafe(48)
        user = github_user(9991010, 'provider', user_metadata={'full_name': '깃허브 표시 이름'})
        code = self.supabase.login(challenge_of(verifier), user)
        status, result = self.call('POST', '/onboarding/login', data=dict(code=code, verifier=verifier))
        self.assertEqual(status, 200)
        self.assertEqual(result['name'], '깃허브 표시 이름')
        account = self.call('GET', token=result['session'])[1]
        again = self.login(user, name='바꾸려는 이름')[1]
        self.assertEqual(again['name'], '깃허브 표시 이름')
        self.assertEqual(self.call('GET', token=again['session'])[1]['id'], account['id'])

    def test_multiline_topic_is_accepted_and_names_stay_single_line(self):
        token = self.login()[1]['session']
        self.consent(token)
        status, body = self.call('POST', '/onboarding/teams', token, dict(request_id=str(uuid.uuid4()), name='팀\n이름', topic='주제'))
        self.assertEqual((status, body['error']), (400, '팀 이름을 확인해 주세요. (한 줄, 80자 이하)'))
        status, body = self.call('POST', '/onboarding/teams', token, dict(request_id=str(uuid.uuid4()), name='팀', topic='주제\x00'))
        self.assertEqual((status, body['error']), (400, '프로젝트 주제를 확인해 주세요. (1200자 이하)'))
        status, team = self.call('POST', '/onboarding/teams', token, dict(request_id=str(uuid.uuid4()), name='줄 팀', topic='목표\r\n- 범위\r\t규칙\n'))
        self.assertEqual(status, 200)
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT topic FROM syncup.onboarding_teams WHERE team_id=%s', (team['id'],)).fetchone()[0], '목표\n- 범위\n\t규칙')

    def test_anonymous_flood_does_not_starve_signed_in_reads(self):
        token = self.login()[1]['session']
        saved = onboarding.LIMIT.calls.copy()
        try:
            while onboarding.LIMIT.take():
                pass
            self.assertEqual(self.call('GET')[0], 429)
            self.assertEqual(self.call('GET', token=token)[0], 200)
            self.assertEqual(self.team(token)[0], 429)  # POSTs stay on the shared window
            unknown = secrets.token_urlsafe(32)
            statuses = [self.call('GET', token=unknown)[0] for _ in range(onboarding.PER_SESSION[0] + 1)]
            self.assertEqual((statuses[0], statuses[-1]), (401, 429))  # per-token cap on junk tokens
            self.assertEqual(self.call('DELETE', token=token)[0], 200)
        finally:
            onboarding.LIMIT.calls.clear()
            onboarding.LIMIT.calls.extend(saved)
        saved = onboarding.SESSION_LIMIT.calls.copy()
        try:
            for _ in range(onboarding.MAX_SESSIONS + 5):
                onboarding.take_session(secrets.token_urlsafe(32))
            self.assertLessEqual(len(onboarding.sessions), onboarding.MAX_SESSIONS)
            self.assertFalse(onboarding.take_session(secrets.token_urlsafe(32)))  # shared cap for unknown tokens
        finally:
            onboarding.SESSION_LIMIT.calls.clear()
            onboarding.SESSION_LIMIT.calls.extend(saved)

    def test_consent_gates_team_creation(self):
        token = self.login()[1]['session']
        self.assertIsNone(self.call('GET', token=token)[1]['consent'])
        status, body = self.team(token, consent=False)
        self.assertEqual((status, body['error']), (403, '먼저 이용약관과 개인정보 처리방침에 동의해 주세요.'))
        status, body = self.consent(token, terms='beta-0.0')
        self.assertEqual((status, body['error']), (409, '약관이 바뀌었어요. 화면을 새로고침해 다시 확인해 주세요.'))
        for change in (dict(age14=False), dict(transfer='yes'), dict(extra=1)):
            self.assertEqual(self.consent(token, **change)[0], 400, change)
        self.assertIsNone(self.call('GET', token=token)[1]['consent'])
        status, signed = self.consent(token)
        self.assertEqual(status, 200)
        self.assertEqual((signed['consent']['terms'], signed['consent']['privacy']), ('beta-0.1', 'beta-0.1'))
        self.assertRegex(signed['consent']['at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(signed['teams'], [])
        time.sleep(1.1)
        self.assertEqual(self.consent(token)[1]['consent'], signed['consent'])  # first timestamp kept
        self.assertEqual(self.call('GET', token=token)[1]['consent'], signed['consent'])
        self.assertEqual(self.team(token, consent=False)[0], 200)
        with psycopg.connect(self.admin_dsn) as c:  # a newer document version requires consent again
            c.execute("UPDATE syncup.onboarding_consents SET terms_version='beta-0.0'")
        self.assertIsNone(self.call('GET', token=token)[1]['consent'])

    def test_decline_deletes_only_a_fresh_account(self):
        token = self.login()[1]['session']
        other = self.login()[1]['session']  # a second session of the same account goes too
        user = self.call('GET', token=token)[1]['id']
        self.assertEqual(self.call('POST', '/onboarding/decline', token, {'x': 1})[0], 400)
        self.assertEqual(self.call('POST', '/onboarding/decline', token, {}), (200, {'deleted': True}))
        self.assertEqual(self.call('GET', token=other)[0], 401)
        with psycopg.connect(self.admin_dsn) as c:
            for table, column in (('users', 'id'), ('identities', 'user_id'), ('onboarding_sessions', 'user_id')):
                self.assertEqual(c.execute(f'SELECT count(*) FROM syncup.{table} WHERE {column}=%s', (user,)).fetchone()[0], 0)
        again = self.login()[1]['session']  # the same GitHub account can sign up afresh
        self.assertNotEqual(self.call('GET', token=again)[1]['id'], user)
        refused = (409, {'error': '이미 동의했거나 팀이 있는 계정은 여기서 지울 수 없어요. 문의처로 요청해 주세요.'})
        self.consent(again)
        self.assertEqual(self.call('POST', '/onboarding/decline', again, {}), refused)
        member = self.login(github_user(9991020, 'member'))[1]['session']
        member_id = self.call('GET', token=member)[1]['id']
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('INSERT INTO syncup.memberships(team_id,user_id) VALUES (%s,%s)', (self.teams['A'], member_id))
        self.assertEqual(self.call('POST', '/onboarding/decline', member, {}), refused)
        self.assertEqual(self.call('GET', token=member)[0], 200)
        self.assertEqual(self.call('POST', '/onboarding/decline', secrets.token_urlsafe(32), {})[0], 401)

    def test_migration_twice_keeps_account_team_and_membership(self):
        token = self.login()[1]['session']
        team = self.team(token)[1]
        self.admin('migrate-integration')
        self.admin('migrate-integration')
        verify_database(self.api_dsn, web_keys=True)
        self.assertEqual(self.call('GET', token=token)[1]['teams'][0]['id'], team['id'])


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(own_tests(Onboarding))
    raise SystemExit(not result.wasSuccessful())
