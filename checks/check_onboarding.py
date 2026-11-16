"""Self-service signup/team creation on isolated real PostgreSQL and fake Supabase. No production connections."""
import repo_paths  # noqa: F401
import base64
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
        onboarding.LIMIT.calls.clear()  # each test starts with a fresh anonymous window
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

    PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 24
    JPEG = b'\xff\xd8\xff\xe0' + b'0' * 24
    WEBP = b'RIFF\x20\x00\x00\x00WEBPVP8 ' + b'0' * 24

    def image(self, kind, raw):
        return dict(image=f'data:image/{kind};base64,' + base64.b64encode(raw).decode())

    def photo(self, token, kind, raw):
        return self.call('PUT', '/onboarding/profile/photo', token, self.image(kind, raw))

    def put_profile(self, token, **change):
        data = dict(name='하늘', school='한국대학교', major='인공지능학과', grade='3학년', role='프론트엔드')
        return self.call('PUT', '/onboarding/profile', token, dict(data, **change))

    def test_profile_round_trip_and_consent_gate(self):
        token = self.login()[1]['session']
        status, empty = self.call('GET', '/onboarding/profile', token)
        subject = self.identity['identities'][0]['id']
        self.assertEqual((status, empty), (200, dict(name='새 사용자', school=None, major=None, grade=None, role=None,
            photo=None, github_avatar=f'https://avatars.githubusercontent.com/u/{subject}?s=256', updated_at=None)))
        refused = (403, {'error': '먼저 이용약관과 개인정보 처리방침에 동의해 주세요.'})
        self.assertEqual(self.put_profile(token), refused)
        self.assertEqual(self.photo(token, 'png', self.PNG), refused)
        self.assertEqual(self.call('GET', '/onboarding/profile', token)[1]['name'], '새 사용자')
        self.consent(token)
        status, saved = self.put_profile(token, name='  하늘  ', school=' 한국대학교 ')
        self.assertEqual(status, 200)
        self.assertEqual((saved['name'], saved['school'], saved['major'], saved['grade'], saved['role']),
                         ('하늘', '한국대학교', '인공지능학과', '3학년', '프론트엔드'))
        self.assertRegex(saved['updated_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
        self.assertEqual(self.call('GET', '/onboarding/profile', token), (200, saved))
        self.assertEqual(self.call('GET', token=token)[1]['name'], '하늘')  # users.name changed
        status, cleared = self.put_profile(token, school='', major=None, grade=None, role='   ')
        self.assertEqual((status, cleared['school'], cleared['major'], cleared['grade'], cleared['role']),
                         (200, None, None, None, None))
        self.assertEqual(self.call('GET', '/onboarding/profile')[0], 401)
        self.assertEqual(self.call('PUT', '/onboarding/profile', secrets.token_urlsafe(32), {})[0], 401)

    def test_profile_validation_in_api_and_sql(self):
        token = self.login()[1]['session']
        self.consent(token)
        for change in (dict(name=''), dict(name=' '), dict(name='가' * 41), dict(name='하\n늘'), dict(name=5),
                       dict(school='가' * 61), dict(school='한\n국'), dict(school='한\t국'), dict(major='전' * 61),
                       dict(role='역' * 81), dict(role='a\x00b'), dict(grade='6학년'), dict(grade=3), dict(school=7)):
            status, body = self.put_profile(token, **change)
            self.assertEqual(status, 400, change)
            self.assertIn('error', body)
        self.assertEqual(self.put_profile(token, name='가' * 40, school='가' * 60, role='역' * 80)[0], 200)
        for grade in ('1학년', '2학년', '3학년', '4학년', '5학년 이상', '대학원', '기타'):
            self.assertEqual(self.put_profile(token, grade=grade)[0], 200, grade)
        status, _ = self.call('PUT', '/onboarding/profile', token, dict(name='하늘'))
        self.assertEqual(status, 400)
        digest = onboarding.digest(token)
        with psycopg.connect(self.api_dsn) as c:  # the SQL function refuses the same inputs without the API
            for args in (('', None, None, None, None), ('하\n늘', None, None, None, None), ('하늘', '가' * 61, None, None, None),
                         ('하늘', None, None, '6학년', None), ('하늘', None, None, None, '역' * 81)):
                with self.assertRaises(psycopg.errors.InvalidParameterValue):
                    c.execute('SELECT syncup.onboarding_profile_save(%s,%s,%s,%s,%s,%s)', (digest, *args))
                c.rollback()
        with psycopg.connect(self.admin_dsn) as c:  # and the table itself
            user = c.execute('SELECT user_id FROM syncup.onboarding_sessions WHERE digest=%s', (digest,)).fetchone()[0]
            for column, value in (('school', '가\n'), ('grade', '9학년'), ('role', ' x'), ('major', '')):
                with self.assertRaises(psycopg.errors.CheckViolation):
                    c.execute(f'UPDATE syncup.onboarding_profiles SET {column}=%s WHERE user_id=%s', (value, user))
                c.rollback()

    def test_photo_type_size_and_magic_checks(self):
        token = self.login()[1]['session']
        self.consent(token)
        for kind, raw in (('png', self.PNG), ('jpeg', self.JPEG), ('webp', self.WEBP)):
            status, body = self.photo(token, kind, raw)
            self.assertEqual(status, 200, kind)
            self.assertEqual(body['photo'], f'data:image/{kind};base64,' + base64.b64encode(raw).decode())
            self.assertEqual(self.call('GET', '/onboarding/profile', token)[1]['photo'], body['photo'])
        self.put_profile(token)
        self.assertIsNotNone(self.call('GET', '/onboarding/profile', token)[1]['photo'])  # saving text keeps the photo
        for kind, raw in (('png', self.JPEG), ('jpeg', self.PNG), ('webp', self.PNG), ('png', b'x' * 40),
                          ('png', self.PNG[:8]), ('png', b'')):
            self.assertEqual(self.photo(token, kind, raw)[0], 400, (kind, raw[:6]))
        for bad in (dict(image='data:image/svg+xml;base64,' + base64.b64encode(self.PNG).decode()),
                    dict(image='data:image/gif;base64,' + base64.b64encode(self.PNG).decode()),
                    dict(image='data:image/png;base64,@@@@'), dict(image='data:image/png;base64,iVBOR'),
                    dict(image='https://example.com/a.png'), dict(image=self.image('png', self.PNG)['image'], x=1),
                    dict(image=5), {}):
            self.assertEqual(self.call('PUT', '/onboarding/profile/photo', token, bad)[0], 400, bad)
        self.assertEqual(self.photo(token, 'png', self.PNG + b'0' * (300_000 - len(self.PNG)))[0], 200)  # exactly the limit
        status, body = self.photo(token, 'png', self.PNG + b'0' * (300_001 - len(self.PNG)))
        self.assertEqual(status, 400)
        status, body = self.photo(token, 'png', self.PNG + b'0' * 400_000)  # over the 420 KB request limit
        self.assertEqual((status, body['error']), (400, '사진 크기를 확인해 주세요. (300KB 이하)'))
        # Only the photo path accepts a large body; the others keep the small limit.
        status, body = self.call('PUT', '/onboarding/profile', token, dict(name='하늘', school='가' * 9000, major=None, grade=None, role=None))
        self.assertEqual(status, 400)
        status, body = self.call('POST', '/onboarding/withdraw', token, dict(confirm='가' * 9000))
        self.assertEqual(status, 400)
        digest = onboarding.digest(token)
        with psycopg.connect(self.api_dsn) as c:
            for args in (('image/png', self.JPEG), ('image/gif', self.PNG), ('image/png', None), (None, self.PNG)):
                with self.assertRaises(psycopg.errors.InvalidParameterValue):
                    c.execute('SELECT syncup.onboarding_photo_set(%s,%s,%s)', (digest, *args))
                c.rollback()
        with psycopg.connect(self.admin_dsn) as c:
            user = c.execute('SELECT user_id FROM syncup.onboarding_sessions WHERE digest=%s', (digest,)).fetchone()[0]
            with self.assertRaises(psycopg.errors.CheckViolation):
                c.execute("UPDATE syncup.onboarding_profiles SET photo=%s, photo_type='image/png' WHERE user_id=%s", (self.JPEG, user))
            c.rollback()
        status, gone = self.call('DELETE', '/onboarding/profile/photo', token)
        self.assertEqual((status, gone['photo']), (200, None))
        self.assertEqual(self.call('DELETE', '/onboarding/profile/photo', token)[0], 200)
        self.assertIsNone(self.call('GET', '/onboarding/profile', token)[1]['photo'])
        with psycopg.connect(self.api_dsn) as c:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                c.execute('SELECT * FROM syncup.onboarding_profiles')
        verify_database(self.api_dsn, web_keys=True)

    def test_withdraw_keeps_cards_removes_the_person_and_deletes_sole_teams(self):
        subject = github_user(9991100, 'leaver')
        token = self.login(subject, name='떠날 사람')[1]['session']
        self.consent(token)
        self.put_profile(token, name='떠날 사람')
        self.photo(token, 'png', self.PNG)
        user = self.call('GET', token=token)[1]['id']
        sole = self.team(token, name='혼자 팀')[1]['id']
        key = self.state / 'leaver.key'
        self.admin('token', '--user', user, '--output', str(key))
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('INSERT INTO syncup.memberships(team_id,user_id) VALUES (%s,%s)', (self.teams['A'], user))
            for team, card in ((self.teams['A'], 'shared-card'), (sole, 'sole-card')):
                c.execute('INSERT INTO syncup.shared_cards(team_id,id,approved_by,approved_at,packet) VALUES (%s,%s,%s,1790000000,%s)',
                          (team, card, user, Jsonb(self.packet(card))))
            c.execute("INSERT INTO syncup.todo_states(team_id,card_id,done,actor) VALUES (%s,'sole-card',true,%s)", (sole, user))
            c.execute("INSERT INTO syncup.record_states(team_id,card_id) VALUES (%s,'sole-card')", (sole,))
            c.execute("INSERT INTO syncup.invites(id,team_id,code_hash,created_by,expires_at) VALUES (gen_random_uuid(),%s,%s,%s,now()+interval '1 day')",
                      (sole, secrets.token_hex(32), user))
            others = c.execute('SELECT user_id FROM syncup.memberships WHERE team_id=%s AND user_id<>%s ORDER BY user_id',
                               (self.teams['A'], user)).fetchall()
        self.assertEqual(request(self.api, 'GET', '/teams/' + self.teams['A'] + '/settings', key.read_text().strip())[0], 200)
        mismatch = (400, {'error': '이름이 맞지 않아요. 지금 이름을 그대로 입력해 주세요.'})
        for confirm in ('', '다른 이름', '떠날'):
            self.assertEqual(self.call('POST', '/onboarding/withdraw', token, dict(confirm=confirm)), mismatch)
        for bad in ({}, dict(confirm=5), dict(confirm='떠날 사람', extra=1)):
            self.assertEqual(self.call('POST', '/onboarding/withdraw', token, bad)[0], 400)
        self.assertEqual(self.call('GET', token=token)[0], 200)  # nothing happened yet
        self.assertEqual(self.call('POST', '/onboarding/withdraw', secrets.token_urlsafe(32), dict(confirm='x'))[0], 401)
        self.assertEqual(self.call('POST', '/onboarding/withdraw', token, dict(confirm=' 떠날 사람 ')), (200, {'deleted': True}))
        self.assertEqual(self.call('GET', token=token)[0], 401)
        self.assertEqual(self.call('GET', '/onboarding/profile', token)[0], 401)
        self.assertEqual(request(self.api, 'GET', '/teams/' + self.teams['A'] + '/settings', key.read_text().strip())[0], 401)
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT active, name FROM syncup.users WHERE id=%s', (user,)).fetchone(), (False, '탈퇴한 팀원'))
            for table in ('identities', 'onboarding_sessions', 'onboarding_consents', 'onboarding_profiles',
                          'onboarding_teams', 'tokens', 'memberships'):
                self.assertEqual(c.execute(f'SELECT count(*) FROM syncup.{table} WHERE user_id=%s', (user,)).fetchone()[0], 0, table)
            # The shared team keeps its cards (now under the withdrawn name) and its other members.
            self.assertEqual(c.execute("SELECT approved_by FROM syncup.shared_cards WHERE team_id=%s AND id='shared-card'",
                                       (self.teams['A'],)).fetchone()[0], uuid.UUID(user))
            self.assertEqual(c.execute('SELECT user_id FROM syncup.memberships WHERE team_id=%s ORDER BY user_id',
                                       (self.teams['A'],)).fetchall(), others)
            self.assertEqual(c.execute('SELECT count(*) FROM syncup.teams WHERE id=%s', (self.teams['A'],)).fetchone()[0], 1)
            # The team nobody else belonged to is gone with everything in it.
            for table, column in (('teams', 'id'), ('shared_cards', 'team_id'), ('todo_states', 'team_id'),
                                  ('record_states', 'team_id'), ('invites', 'team_id'), ('team_settings', 'team_id'),
                                  ('memberships', 'team_id'), ('onboarding_teams', 'team_id')):
                self.assertEqual(c.execute(f'SELECT count(*) FROM syncup.{table} WHERE {column}=%s', (sole,)).fetchone()[0], 0, table)
        self.assertEqual(self.login(subject, name='다시 온 사람')[0], 200)  # the same GitHub login starts a new account
        again = self.login(subject, name='다시 온 사람')[1]['session']
        account = self.call('GET', token=again)[1]
        self.assertNotEqual(account['id'], user)
        self.assertEqual((account['name'], account['teams'], account['consent']), ('다시 온 사람', [], None))
        self.assertEqual(self.call('GET', '/onboarding/profile', again)[1]['school'], None)

    def test_withdraw_needs_no_consent_and_survives_a_team_with_removed_members(self):
        token = self.login(github_user(9991101, 'fresh'), name='막 가입')[1]['session']
        self.assertIsNone(self.call('GET', token=token)[1]['consent'])
        self.assertEqual(self.call('POST', '/onboarding/withdraw', token, dict(confirm='막 가입')), (200, {'deleted': True}))
        token = self.login(github_user(9991102, 'last'), name='마지막')[1]['session']
        team = self.team(token)[1]['id']
        user = self.call('GET', token=token)[1]['id']
        with psycopg.connect(self.admin_dsn) as c:  # a member who was taken out earlier does not keep the team alive
            c.execute('INSERT INTO syncup.memberships(team_id,user_id,active) VALUES (%s,%s,false)', (team, self.users['Bob']))
        self.assertEqual(self.call('POST', '/onboarding/withdraw', token, dict(confirm='마지막'))[0], 200)
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM syncup.teams WHERE id=%s', (team,)).fetchone()[0], 0)
            self.assertEqual(c.execute('SELECT count(*) FROM syncup.users WHERE id=%s AND NOT active', (user,)).fetchone()[0], 1)
        verify_database(self.api_dsn, web_keys=True)

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
