"""Web login → team connection key, end to end on real PostgreSQL: fake Supabase Auth (fake_supabase.py), the real team
API, the registered native host and the collector CLI. Synthetic users and GitHub IDs only."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import concurrent.futures
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import time
import unittest
import uuid

import psycopg

from check_teams import TeamIsolation, own_tests, reported_address, request
from fake_supabase import PROVIDER_TOKEN, challenge_of, fake_supabase, github_user
from key_issue import KeyIssuer
import key_setup
from prepare_native import prepare
from team_access import DatabaseSetupError, verify_database

ROOT = repo_paths.REPO
GITHUB = {'Alice': 1001, 'Bob': 1002, 'Dana': 1003}


class WebKeys(TeamIsolation):
    def setUp(self):
        super().setUp()
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('DELETE FROM syncup.key_events')
            c.execute('DELETE FROM syncup.identities')
        for name, github_id in GITHUB.items():
            self.admin('identity', '--provider', 'github', '--subject', str(github_id), '--user', self.users[name],
                       '--note', name.lower())
        self.supabase = self.enterContext(fake_supabase())
        self.api.key_issuer = KeyIssuer(self.supabase.url, self.supabase.key)

    # One PC: a new state folder with a native host registered for this team API, as docs/running.md describes.
    def new_pc(self, team_api=True):
        state = self.root / ('pc-' + uuid.uuid4().hex[:8])
        native = self.root / ('native-' + uuid.uuid4().hex[:8])
        manifest = prepare('a' * 32, state / 'connection.json', native, self.url if team_api else None)
        return state, json.loads(manifest.read_text())

    def host(self, registration, method, **params):
        return self.native_frame(registration, method, params)

    def web_login(self, registration, user):
        """What /connect and /auth/callback do: setup.begin, the GitHub login, then setup.connect with the code."""
        challenge = self.host(registration, 'setup.begin')['result']['challenge']
        return self.host(registration, 'setup.connect', code=self.supabase.login(challenge, user))

    def post_keys(self, **body):
        status, raw = request(self.api, 'POST', '/keys', data=body)
        return status, json.loads(raw)

    def direct(self, user, digest=None, verifier=None, method='oauth', **extra):
        """POST /keys as a native host would, without one: returns (status, body, digest)."""
        verifier = verifier or secrets.token_urlsafe(64)
        digest = digest or hashlib.sha256(secrets.token_urlsafe(32).encode()).hexdigest()
        code = self.supabase.login(challenge_of(verifier), user, method)
        status, body = self.post_keys(code=code, verifier=verifier, digest=digest, device='macOS', **extra)
        return status, body, digest

    def events(self):
        with psycopg.connect(self.admin_dsn) as c:
            return c.execute('SELECT outcome, provider, user_id::text FROM syncup.key_events ORDER BY id').fetchall()

    def web_tokens(self, name):
        with psycopg.connect(self.admin_dsn) as c:
            return c.execute("""SELECT digest, revoked FROM syncup.tokens WHERE user_id=%s AND issued_via='web'
                ORDER BY issued_at""", (self.users[name],)).fetchall()

    def test_native_host_gets_a_key_and_the_collector_starts_with_it(self):
        state, registration = self.new_pc()
        self.assertEqual(self.host(registration, 'setup.status'),
                         dict(ok=True, result=dict(hostReady=True, keyPresent=False, expiresAt=None)))
        answer = self.web_login(registration, github_user(GITHUB['Alice'], 'alice'))
        self.assertTrue(answer['ok'], answer)
        self.assertEqual((answer['result']['name'], answer['result']['teams']), ('Alice', ['A팀']))
        text = json.dumps(answer, ensure_ascii=False)
        key = (state / 'team.key').read_text().strip()
        for secret in (key, PROVIDER_TOKEN, str(state)):
            self.assertNotIn(secret, text)
        for name in ('team.key', 'team.json'):
            self.assertEqual(stat.S_IMODE((state / name).stat().st_mode), 0o600, name)
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
        self.assertFalse((state / 'login.pending').exists())
        self.assertEqual((state / '.gitignore').read_text(), '*\n')
        self.assertEqual(json.loads(request(self.api, 'GET', '/me', key)[1])['name'], 'Alice')
        self.assertEqual(self.events(), [('issued', 'github', self.users['Alice'])])
        self.assertEqual(len(self.supabase.logged_out), 1)  # the Supabase session ends right after the issue
        status = self.host(registration, 'setup.status')['result']
        self.assertEqual((status['keyPresent'], status['expiresAt']), (True, answer['result']['expiresAt']))
        self.assertEqual(json.loads((state / 'team.json').read_text())['api_url'], self.url)

        # The collector needs neither --team-api nor --team-token-file now, and refuses a different server.
        command = [sys.executable, str(ROOT / 'collector' / 'app.py'), 'run', '--project', str(state), '--state', str(state),
                   '--port', '0', '--codex-dir', str(state / 'none'), '--claude-dir', str(state / 'none')]
        wrong = subprocess.run(command + ['--team-api', 'https://other.invalid', '--team-token-file', str(state / 'team.key')],
                               capture_output=True, text=True, timeout=10)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn('team.json', wrong.stderr)
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            status, html = request(reported_address(child, 'Review CLI', timeout=10), 'GET', '/')
            self.assertEqual(status, 200)
            self.assertIn('A팀', html)
        finally:
            child.terminate()
            child.communicate(timeout=5)

        # Logging in again on this PC replaces this PC's key only; the bound user cannot change.
        again = self.web_login(registration, github_user(GITHUB['Alice'], 'alice'))
        self.assertTrue(again['ok'], again)
        self.assertEqual(request(self.api, 'GET', '/me', key)[0], 401)
        new_key = (state / 'team.key').read_text().strip()
        self.assertEqual(request(self.api, 'GET', '/me', new_key)[0], 200)
        self.assertEqual([revoked for _, revoked in self.web_tokens('Alice')], [True, False])
        other = self.web_login(registration, github_user(GITHUB['Bob'], 'bob'))
        self.assertEqual(other, dict(ok=False, error=key_setup.OTHER_USER))
        self.assertEqual((state / 'team.key').read_text().strip(), new_key)
        self.assertEqual(list(state.glob('.team.key.*')), [])

    def test_strangers_spoofed_identities_and_bad_logins_get_no_key(self):
        state, registration = self.new_pc()
        alice_id = GITHUB['Alice']
        stranger = github_user(9999, 'stranger')
        spoofed = github_user(9999, 'stranger', user_metadata=dict(provider_id=str(alice_id), sub=str(alice_id)))
        foreign = github_user(alice_id, 'alice')
        foreign['identities'][0]['user_id'] = str(uuid.uuid4())
        with_email = github_user(alice_id, 'alice')
        with_email['identities'].append(dict(with_email['identities'][0], provider='email', id=str(uuid.uuid4())))
        two_people = github_user(alice_id, 'alice')
        two_people['identities'].append(dict(two_people['identities'][0], id=str(GITHUB['Bob'])))
        for user, expected in [(stranger, 403), (spoofed, 403), (foreign, 403), (with_email, 403), (two_people, 403)]:
            with self.subTest(login=user['user_metadata']):
                self.assertEqual(self.web_login(registration, user), dict(ok=False, error=key_setup.ANSWERS[expected]))
                self.assertFalse((state / 'team.key').exists())
        self.assertEqual([e[0] for e in self.events()], ['unknown', 'unknown', 'ambiguous'])
        self.assertTrue(all(e[2] is None for e in self.events()))
        self.assertEqual(self.direct(github_user(alice_id, 'alice'), method='password')[0], 401)
        self.admin('identity', '--provider', 'github', '--subject', str(GITHUB['Dana']), '--remove')
        self.assertEqual(self.direct(github_user(GITHUB['Dana'], 'dana'))[0], 403)
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('UPDATE syncup.users SET active=false WHERE id=%s', (self.users['Bob'],))
        self.assertEqual(self.direct(github_user(GITHUB['Bob'], 'bob'))[0], 403)
        self.assertEqual(self.web_tokens('Alice') + self.web_tokens('Bob') + self.web_tokens('Dana'), [])

        # A code is useless without its verifier, and is exchanged once.
        verifier = secrets.token_urlsafe(64)
        code = self.supabase.login(challenge_of(verifier), github_user(alice_id, 'alice'))
        digest = hashlib.sha256(b'synthetic').hexdigest()
        self.assertEqual(self.post_keys(code=code, verifier=secrets.token_urlsafe(64), digest=digest, device='macOS')[0], 401)
        code = self.supabase.login(challenge_of(verifier), github_user(alice_id, 'alice'))
        self.assertEqual(self.post_keys(code=code, verifier=verifier, digest=digest, device='macOS')[0], 200)
        self.assertEqual(self.post_keys(code=code, verifier=verifier, digest=hashlib.sha256(b'x').hexdigest(),
                                   device='macOS')[0], 401)

        # A host started over: the latest login only, and none older than 10 minutes.
        first = self.host(registration, 'setup.begin')['result']['challenge']
        self.host(registration, 'setup.begin')
        self.assertEqual(self.host(registration, 'setup.connect', code=self.supabase.login(first, foreign)),
                         dict(ok=False, error=key_setup.ANSWERS[401]))
        challenge = self.host(registration, 'setup.begin')['result']['challenge']
        pending = json.loads((state / 'login.pending').read_text())
        key_setup.write_private(state / 'login.pending', json.dumps(dict(pending, at=time.time() - 601)))
        self.assertEqual(self.host(registration, 'setup.connect', code=self.supabase.login(challenge, foreign)),
                         dict(ok=False, error=key_setup.START_AGAIN))
        self.assertEqual(self.host(registration, 'setup.connect', code='not-a-code'),
                         dict(ok=False, error=key_setup.START_AGAIN))

    def test_request_format_feature_switch_and_failures_never_reach_or_leak(self):
        verifier, digest = secrets.token_urlsafe(64), hashlib.sha256(b'x').hexdigest()
        good = dict(code=str(uuid.uuid4()), verifier=verifier, digest=digest, device='macOS')
        for bad in ({}, dict(good, code='x'), dict(good, verifier='short'), dict(good, digest='A' * 64),
                    dict(good, device='Linux'), dict(good, replaces='x'), dict(good, extra='1'), dict(good, code=1)):
            with self.subTest(bad=bad):
                self.assertEqual(self.post_keys(**bad)[0], 400)
        self.assertEqual(self.supabase.exchanges(), 0)
        self.assertEqual(request(self.api, 'GET', '/keys')[0], 405)
        self.assertEqual(request(self.api, 'POST', '/keys?x=1', data=good)[0], 404)
        self.supabase.failure = 500
        with self.assertLogs('syncup', 'WARNING') as logs:
            status, body = self.post_keys(**dict(good, code=self.supabase.login(challenge_of(verifier), github_user(1, 'a'))))
        self.assertEqual(status, 503)
        for secret in (verifier, digest, good['code']):
            self.assertNotIn(secret, '\n'.join(logs.output) + json.dumps(body))
        self.api.key_issuer = None
        self.assertEqual(self.post_keys(**good)[0], 404)
        _, registration = self.new_pc(team_api=False)
        self.assertEqual(self.host(registration, 'setup.connect', code=str(uuid.uuid4())),
                         dict(ok=False, error=key_setup.NO_TEAM_API))

    def test_retry_cap_rate_and_concurrency_are_enforced_in_the_database(self):
        alice = github_user(GITHUB['Alice'], 'alice')
        verifier, digest = secrets.token_urlsafe(64), hashlib.sha256(b'retry').hexdigest()
        body = dict(code=self.supabase.login(challenge_of(verifier), alice), verifier=verifier, digest=digest, device='macOS')
        first, second = self.post_keys(**body), self.post_keys(**body)
        self.assertEqual((first[0], second), (200, first))  # a lost answer is retried with the same digest
        self.assertEqual((self.supabase.exchanges(), len(self.web_tokens('Alice'))), (1, 1))
        digests = [digest] + [self.direct(alice)[2] for _ in range(2)]
        self.assertEqual(self.direct(alice)[0], 409)  # three active web keys: a fourth PC waits for the admin
        status, _, replacement = self.direct(alice, replaces=digests[0])
        self.assertEqual(status, 200)
        self.assertEqual({d: r for d, r in self.web_tokens('Alice')}[digests[0]], True)
        status, _, replacement = self.direct(alice, replaces=replacement)
        self.assertEqual(status, 200)
        self.assertEqual(self.direct(alice, replaces=replacement)[0], 429)  # 5 issues in the last hour
        with concurrent.futures.ThreadPoolExecutor(5) as pool:
            statuses = sorted(pool.map(lambda _: self.direct(github_user(GITHUB['Bob'], 'bob'))[0], range(5)))
        self.assertEqual(statuses, [200, 200, 200, 409, 409])
        self.assertEqual(sum(not revoked for _, revoked in self.web_tokens('Bob')), 3)

    def test_database_keeps_the_api_role_out_and_the_startup_check_notices_drift(self):
        verify_database(self.api_dsn, web_keys=True)
        with psycopg.connect(self.api_dsn) as c:
            for table in ('identities', 'key_events', 'tokens'):
                with self.subTest(table=table), self.assertRaises(psycopg.errors.InsufficientPrivilege), c.transaction():
                    c.execute('SELECT * FROM syncup.' + table)
            # A temporary table named like a SyncUp table changes nothing: the functions qualify every name.
            c.execute('CREATE TEMP TABLE identities(provider text, subject text, user_id uuid)')
            c.execute("INSERT INTO identities VALUES('github','4242',%s)", (self.users['Alice'],))
            row = c.execute("SELECT * FROM syncup.issue_web_key(%s::jsonb,%s,%s,NULL,'macOS')",
                            ('[{"provider":"github","subject":"4242"}]', '0' * 64, '1' * 64)).fetchone()
            self.assertEqual(row[0], 'unknown')
        for drift, undo in [
                ('ALTER FUNCTION syncup.issue_web_key(jsonb,text,text,text,text) SECURITY INVOKER', None),
                ('ALTER FUNCTION syncup.replay_web_key(text) RESET search_path', None),
                ('GRANT SELECT ON syncup.identities TO syncup_api', 'REVOKE SELECT ON syncup.identities FROM syncup_api'),
                ('ALTER TABLE syncup.key_events NO FORCE ROW LEVEL SECURITY', None)]:
            with self.subTest(drift=drift):
                with psycopg.connect(self.admin_dsn) as c:
                    c.execute(drift)
                with self.assertRaisesRegex(DatabaseSetupError, '웹 연결 키'):
                    verify_database(self.api_dsn, web_keys=True)
                verify_database(self.api_dsn)  # a server without web keys still starts
                with psycopg.connect(self.admin_dsn) as c:
                    if undo:
                        c.execute(undo)
                self.admin('migrate-integration')
                verify_database(self.api_dsn, web_keys=True)

    def test_admin_identity_and_revocation_commands(self):
        command = [sys.executable, str(ROOT / 'server' / 'team_admin.py')]
        env = dict(os.environ, SYNCUP_ADMIN_DATABASE_URL=self.admin_dsn)
        for args, hint in [(['identity', '--provider', 'github', '--subject', 'alice', '--user', self.users['Alice']],
                            'gh api users'),
                           (['identity', '--provider', 'github', '--subject', '7'], '--user'),
                           (['revoke-tokens'], '--via')]:
            with self.subTest(args=args):
                done = subprocess.run(command + args, env=env, capture_output=True, text=True)
                self.assertEqual(done.returncode, 1)
                self.assertIn(hint, done.stderr)
        status, _, digest = self.direct(github_user(GITHUB['Alice'], 'alice'))
        self.assertEqual(status, 200)
        self.admin('revoke-tokens', '--via', 'web')
        self.assertEqual([revoked for _, revoked in self.web_tokens('Alice')], [True])
        self.assertEqual(request(self.api, 'GET', '/me', self.tokens['Alice'])[0], 200)  # the admin key still works
        self.admin('revoke-tokens', '--user', self.users['Alice'], '--via', 'admin')
        self.assertEqual(request(self.api, 'GET', '/me', self.tokens['Alice'])[0], 401)
        self.assertEqual(request(self.api, 'GET', '/me', self.tokens['Bob'])[0], 200)


# ── 초대 링크 (server/team_invites.py) ──
class InviteLinks(WebKeys):
    """An active member's link, then a GitHub login that joins with it: new users, known users and every refusal."""

    def setUp(self):
        super().setUp()
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('DELETE FROM syncup.invite_events')
            c.execute('DELETE FROM syncup.invites')
            c.execute('DELETE FROM syncup.identities WHERE user_id <> ALL(%s::uuid[])', (list(self.users.values()),))
            c.execute('DELETE FROM syncup.users WHERE id <> ALL(%s::uuid[])', (list(self.users.values()),))

    def team(self, method, tail, user='Alice', team='A', data=None):
        status, raw = request(self.api, method, f'/teams/{self.teams[team]}/{tail}', self.tokens[user], data)
        return status, json.loads(raw)

    def create(self, user='Alice', team='A'):
        status, body = self.team('POST', 'invites', user, team, {})
        self.assertEqual(status, 200, body)
        return body

    def preview(self, code):
        status, raw = request(self.api, 'POST', '/invites/preview', data=dict(code=code))
        return status, json.loads(raw)

    def join(self, registration, user, code, name='새 팀원'):
        challenge = self.host(registration, 'setup.begin', invite=dict(code=code, name=name))['result']['challenge']
        return self.host(registration, 'setup.connect', code=self.supabase.login(challenge, user))

    def members(self, team='A'):
        with psycopg.connect(self.admin_dsn) as c:
            return sorted(r[0] for r in c.execute("""SELECT u.name FROM syncup.memberships m JOIN syncup.users u
                ON u.id=m.user_id WHERE m.team_id=%s AND m.active""", (self.teams[team],)))

    def invite_outcomes(self):
        with psycopg.connect(self.admin_dsn) as c:
            return [r[0] for r in c.execute('SELECT outcome FROM syncup.invite_events ORDER BY id')]

    def test_a_new_github_user_joins_with_a_link_and_the_collector_sees_the_team(self):
        made = self.create()
        code = made['code']
        self.assertRegex(code, r'^[A-Za-z0-9_-]{24}$')
        self.assertEqual(self.preview(code)[1], dict(status='valid', team='A팀', expires_at=made['expires_at'],
                                                     members=2, member_limit=8))
        state, registration = self.new_pc()
        self.assertEqual(self.host(registration, 'setup.invite', code=code)['result']['team'], 'A팀')
        answer = self.join(registration, github_user(5001, 'erin'), code, name=' 에린 ')
        self.assertTrue(answer['ok'], answer)
        self.assertEqual(answer['result']['invite'], dict(team='A팀', added=True))
        self.assertEqual((answer['result']['name'], answer['result']['teams']), ('에린', ['A팀']))
        self.assertEqual(self.members(), ['Alice', 'Dana', '에린'])
        key = (state / 'team.key').read_text().strip()
        self.assertEqual(json.loads(request(self.api, 'GET', '/me', key)[1])['teams'][0]['name'], 'A팀')
        self.assertNotIn(code, (state / 'login.pending').read_text() if (state / 'login.pending').exists() else '')
        # The list never shows a code, and records who made the link and how many joined.
        status, listed = self.team('GET', 'invites', 'Dana')
        self.assertEqual(status, 200)
        self.assertEqual((listed['members'], listed['member_limit']), (3, 8))
        self.assertEqual([(i['created_by'], i['joined'], i['revoked_at']) for i in listed['invites']],
                         [('Alice', 1, None)])
        self.assertNotIn(code, json.dumps(listed))
        with psycopg.connect(self.admin_dsn) as c:
            dump = json.dumps([list(map(str, r)) for t in ('invites', 'invite_events', 'key_events')
                               for r in c.execute('SELECT * FROM syncup.' + t)])
        self.assertNotIn(code, dump)
        # The same link serves another person; the identity is not re-made for a second login.
        other_state, other = self.new_pc()
        self.assertTrue(self.join(other, github_user(5002, 'finn'), code, name='핀')['ok'])
        self.assertEqual(self.invite_outcomes(), ['joined', 'joined'])

    def test_a_known_user_gets_only_the_membership_and_a_member_gets_a_key(self):
        code = self.create(user='Bob', team='B')['code']
        _, registration = self.new_pc()
        answer = self.join(registration, github_user(GITHUB['Alice'], 'alice'), code, name='무시될 이름')
        self.assertTrue(answer['ok'], answer)
        self.assertEqual(answer['result']['name'], 'Alice')
        self.assertEqual(sorted(answer['result']['teams']), ['A팀', 'B팀'])
        _, again = self.new_pc()
        answer = self.join(again, github_user(GITHUB['Dana'], 'dana'), code)  # Dana is in B already
        self.assertTrue(answer['ok'], answer)
        self.assertEqual(answer['result']['invite'], dict(team='B팀', added=False))
        self.assertEqual(self.members('B'), ['Alice', 'Bob', 'Dana'])
        self.assertEqual(self.invite_outcomes(), ['joined', 'member'])

    def test_expired_revoked_full_forged_and_other_team_links_are_refused(self):
        _, registration = self.new_pc()
        erin = github_user(5101, 'erin')
        made = self.create()
        # Revoke: by any member of the team, not by someone of another team, and at once.
        self.assertEqual(self.team('POST', f"invites/{made['id']}/revoke", 'Bob', 'A', {})[0], 403)
        self.assertEqual(self.team('POST', f"invites/{made['id']}/revoke", 'Bob', 'B', {})[0], 404)
        self.assertEqual(self.team('POST', f"invites/{made['id']}/revoke", 'Dana', 'A', {})[0], 200)
        self.assertEqual(self.preview(made['code'])[1], dict(status='revoked'))
        self.assertEqual(self.join(registration, erin, made['code']),
                         dict(ok=False, error=key_setup.INVITE_ANSWERS['link']))
        # Expired.
        made = self.create()
        with psycopg.connect(self.admin_dsn) as c:
            c.execute("UPDATE syncup.invites SET expires_at=now()-interval '1 second' WHERE id=%s", (made['id'],))
        self.assertEqual(self.preview(made['code'])[1], dict(status='expired'))
        self.assertEqual(self.join(registration, erin, made['code']),
                         dict(ok=False, error=key_setup.INVITE_ANSWERS['link']))
        # Forged: a well-formed code nobody made, and malformed ones that never reach the database.
        forged = secrets.token_urlsafe(18)
        self.assertEqual(self.preview(forged)[1], dict(status='unknown_link'))
        self.assertEqual(self.join(registration, erin, forged), dict(ok=False, error=key_setup.INVITE_ANSWERS['link']))
        for bad in ('short', made['code'] + 'x', made['code'][:-1] + '!'):
            self.assertEqual(self.preview(bad)[0], 400)
            self.assertEqual(self.host(registration, 'setup.begin', invite=dict(code=bad, name='x')),
                             dict(ok=False, error=key_setup.BAD_INVITE))
        # A link of team B joins team B only, never the team of the member who forwards it.
        code_b = self.create(user='Bob', team='B')['code']
        self.assertTrue(self.join(registration, erin, code_b)['ok'])
        self.assertEqual(self.members('A'), ['Alice', 'Dana'])
        # Full: 8 active members. A removed member does not come back through a link.
        code = self.create()['code']
        with psycopg.connect(self.admin_dsn) as c:
            for n in range(6):
                user = c.execute("INSERT INTO syncup.users(id,name) VALUES(gen_random_uuid(),%s) RETURNING id",
                                 (f'채움{n}',)).fetchone()[0]
                c.execute('INSERT INTO syncup.memberships(team_id,user_id) VALUES(%s,%s)', (self.teams['A'], user))
        self.assertEqual(self.preview(code)[1], dict(status='team_full'))
        _, pc = self.new_pc()
        self.assertEqual(self.join(pc, github_user(5102, 'gina'), code),
                         dict(ok=False, error=key_setup.INVITE_ANSWERS['team_full']))
        with psycopg.connect(self.admin_dsn) as c:
            c.execute("DELETE FROM syncup.memberships WHERE team_id=%s AND user_id IN (SELECT id FROM syncup.users WHERE name LIKE '채움%%')", (self.teams['A'],))
            c.execute("DELETE FROM syncup.users WHERE name LIKE '채움%%'")
            c.execute('UPDATE syncup.memberships SET active=false WHERE team_id=%s AND user_id=%s',
                      (self.teams['A'], self.users['Dana']))
        _, pc = self.new_pc()
        self.assertEqual(self.join(pc, github_user(GITHUB['Dana'], 'dana'), code),
                         dict(ok=False, error=key_setup.INVITE_ANSWERS['removed']))
        # Nothing of a refused join stays but its event: no user, identity or membership was made.
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM syncup.identities WHERE subject='5102'").fetchone()[0], 0)
        self.assertEqual(self.invite_outcomes(),
                         ['revoked', 'expired', 'unknown_link', 'joined', 'team_full', 'removed'])

    def test_member_rules_limits_concurrency_and_no_code_in_logs(self):
        self.assertEqual(self.team('POST', 'invites', 'Bob', 'A', {})[0], 403)  # not a member of A
        self.assertEqual(self.team('POST', 'invites', 'Alice', 'A', {'x': 1})[0], 404)
        codes = [self.create()['code'] for _ in range(5)]
        status, body = self.team('POST', 'invites', data={})
        self.assertEqual((status, body['created']), (200, False))  # five open links per team
        # Eight members at most even when many join at once.
        with psycopg.connect(self.admin_dsn) as c:
            for n in range(4):
                user = c.execute("INSERT INTO syncup.users(id,name) VALUES(gen_random_uuid(),%s) RETURNING id",
                                 (f'채움{n}',)).fetchone()[0]
                c.execute('INSERT INTO syncup.memberships(team_id,user_id) VALUES(%s,%s)', (self.teams['A'], user))
        def one(n):
            return self.direct(github_user(6000 + n, f'p{n}'), invite=codes[n % 5], name=f'동시{n}')[0]
        with concurrent.futures.ThreadPoolExecutor(5) as pool:
            statuses = sorted(pool.map(one, range(5)))
        self.assertEqual(statuses, [200, 200, 409, 409, 409])
        self.assertEqual(len(self.members()), 8)
        # Preview is rate limited for the whole server.
        import team_invites
        saved, team_invites.PREVIEW_LIMIT = team_invites.PREVIEW_LIMIT, key_issue_window(2)
        try:
            self.assertEqual([self.preview(codes[0])[0] for _ in range(3)], [200, 200, 429])
        finally:
            team_invites.PREVIEW_LIMIT = saved
        # The code is in no log line or diagnostic, even when the database fails.
        self.api.dsn = self.api_dsn.replace('syncup_api:', 'syncup_api:wrong')
        with self.assertLogs('syncup', 'WARNING') as logs:
            self.assertEqual(self.preview(codes[1])[0], 503)
            self.assertEqual(self.direct(github_user(6100, 'q'), invite=codes[1], name='큐')[0], 503)
        for code in codes:
            self.assertNotIn(code, '\n'.join(logs.output))
        self.api.key_issuer = None
        self.assertEqual(self.preview(codes[0])[0], 404)

    def test_api_role_cannot_reach_invite_tables_and_startup_check_notices_drift(self):
        verify_database(self.api_dsn, web_keys=True)
        with psycopg.connect(self.api_dsn) as c:
            for table in ('invites', 'invite_events'):
                with self.subTest(table=table), self.assertRaises(psycopg.errors.InsufficientPrivilege), c.transaction():
                    c.execute('SELECT * FROM syncup.' + table)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege), c.transaction():  # no member set
                c.execute('SELECT * FROM syncup.create_invite(%s,%s)', (self.teams['A'], 'a' * 64))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege), c.transaction():
                c.execute("SELECT set_config('syncup.user_id',%s,true)", (self.users['Bob'],))
                c.execute('SELECT * FROM syncup.create_invite(%s,%s)', (self.teams['A'], 'a' * 64))
        for drift in ('ALTER FUNCTION syncup.join_with_invite(text,jsonb,text,text,text,text,text) SECURITY INVOKER',
                      'ALTER TABLE syncup.invites NO FORCE ROW LEVEL SECURITY'):
            with self.subTest(drift=drift):
                with psycopg.connect(self.admin_dsn) as c:
                    c.execute(drift)
                with self.assertRaisesRegex(DatabaseSetupError, '초대 링크'):
                    verify_database(self.api_dsn, web_keys=True)
                self.admin('migrate-integration')
                verify_database(self.api_dsn, web_keys=True)


def key_issue_window(limit):
    from key_issue import WindowLimit
    return WindowLimit(limit, 60)


def load_tests(loader, tests, pattern):
    return own_tests(WebKeys, InviteLinks)


if __name__ == '__main__':
    logging.getLogger('syncup').setLevel(logging.WARNING)
    unittest.main(verbosity=2)
