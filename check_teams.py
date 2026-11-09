"""Real PostgreSQL/HTTP isolation checks; creates and stops its own synthetic Docker DB."""
import concurrent.futures
from contextlib import closing, contextmanager
import copy
import http.client
import json
import math
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
import uuid

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

import app
from conflict_checks import process_checks
import delivery
from prepare_native import prepare
from storage import connect, initialize, initialize_v1
from team_access import authorized, verify_database
from team_client import TeamClient, bind_sharing
from team_server import TeamHandler, TeamServer

ROOT = Path(__file__).resolve().parent
QUOTE = '이 문장만 공유합니다.'
PRIVATE = 'UNAPPROVED_PRIVATE_SENTINEL_739'
# card() stores this whole sentence as local evidence; an automatic approval shares only QUOTE.
EVIDENCE = QUOTE + ' ' + PRIVATE


class ObservedTeamHandler(TeamHandler):
    def body(self, limit=65536):
        raw = super().body(limit)
        self.server.received.append(raw)
        return raw

    def do_POST(self):
        if self.server.failure:
            return self.reply(self.server.failure, '{}', 'application/json')
        super().do_POST()

    def reply(self, status, value, mime='text/html; charset=utf-8'):
        if status == 200 and self.command == 'POST' and self.server.lose_reply:
            self.server.lose_reply = False
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if status == 200 and self.command == 'POST' and self.server.bad_team:
            result = json.loads(value)
            result['team_id'] = self.server.bad_team
            value = json.dumps(result)
        super().reply(status, value, mime)


@contextmanager
def running_server(handler):
    srv = TeamServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


def request(srv, method, path, token=None, data=None, form=False):
    """One HTTP request to `srv` (anything with server_port); returns (status, body text)."""
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
    if form:
        headers['Origin'] = f'http://127.0.0.1:{srv.server_port}'
    with closing(http.client.HTTPConnection('127.0.0.1', srv.server_port, timeout=10)) as connection:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, response.read().decode()


def first_line(child, timeout):
    """The child's first stdout line; raises queue.Empty instead of blocking when it prints nothing."""
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
    return lines.get(timeout=timeout)


def reported_address(child, what, timeout=15):
    """The loopback address a CLI prints when it is ready, usable with request()."""
    line = first_line(child, timeout)
    ready = re.search(r'127\.0\.0\.1:(\d+)', line)
    if not ready:
        raise AssertionError(f'{what} did not report readiness: {line}')
    return types.SimpleNamespace(server_port=int(ready.group(1)), process=child)


@contextmanager
def team_api_process(env):
    """Run team_server.py the way operators start it; yields its address and process once it is ready."""
    child = subprocess.Popen([sys.executable, str(ROOT/'team_server.py'), '--port', '0'], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        yield reported_address(child, 'Team API CLI')
    finally:
        if child.poll() is None:
            child.terminate()
        child.communicate(timeout=10)


def own_tests(*classes):
    """Only the tests each class defines itself.

    The team suites inherit one another so they can share one database fixture; the whole chain runs once,
    through check_server_recovery.py, and every other file runs only its own tests with this."""
    names = unittest.defaultTestLoader.getTestCaseNames
    return unittest.TestSuite(cls(name) for cls in classes for name in names(cls) if name in vars(cls))


class TeamIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='syncup-team-tests-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.container = 'syncup-isolation-' + uuid.uuid4().hex[:12]
        admin_password = secrets.token_urlsafe(32)
        env = dict(os.environ, POSTGRES_PASSWORD=admin_password)
        subprocess.run(['docker', 'run', '--rm', '-d', '--name', cls.container,
            '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432',
            '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=syncup_test', 'postgres:17-alpine'],
            env=env, check=True, stdout=subprocess.DEVNULL)
        cls.addClassCleanup(lambda: subprocess.run(['docker', 'stop', cls.container],
            check=True, stdout=subprocess.DEVNULL))
        port = subprocess.check_output(['docker', 'port', cls.container, '5432/tcp'], text=True).strip().split(':')[-1]
        cls.admin_dsn = f'postgresql://postgres:{admin_password}@127.0.0.1:{port}/syncup_test'
        deadline = time.monotonic()+30
        while True:
            try:
                with psycopg.connect(cls.admin_dsn, connect_timeout=1):
                    break
            except psycopg.Error:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.2)
        api_password = secrets.token_urlsafe(32)
        password_file = cls.root/'db-password.key'
        password_file.write_text(api_password, encoding='utf-8')
        password_file.chmod(0o600)
        cls.api_dsn = f'postgresql://syncup_api:{api_password}@127.0.0.1:{port}/syncup_test'
        cls.admin('init', '--api-password-file', str(password_file))
        verify_database(cls.api_dsn)
        cls.users = {name: cls.admin('user', '--name', name) for name in ('Alice', 'Bob', 'Dana')}
        cls.teams = {name: cls.admin('team', '--name', name+'팀') for name in ('A', 'B')}
        with psycopg.connect(cls.admin_dsn) as c:
            version = c.execute('SHOW server_version').fetchone()[0]
        print('REAL PostgreSQL '+version+'; limited API role + RLS; synthetic data only', flush=True)

    @classmethod
    def admin(cls, *args):
        result = subprocess.run([sys.executable, str(ROOT/'team_admin.py'), *args],
            env=dict(os.environ, SYNCUP_ADMIN_DATABASE_URL=cls.admin_dsn),
            text=True, capture_output=True, check=True)
        return result.stdout.strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name).resolve()
        with psycopg.connect(self.admin_dsn) as c:
            for table in ('conflict_events','conflicts','conflict_checks','record_states','todo_states'):
                c.execute('DELETE FROM syncup.'+table)
            c.execute('DELETE FROM syncup.shared_cards')
            c.execute('DELETE FROM syncup.tokens')
            c.execute('DELETE FROM syncup.memberships')
            c.execute('UPDATE syncup.users SET active=true')
        for user, team in [('Alice','A'), ('Bob','B'), ('Dana','A'), ('Dana','B')]:
            self.admin('member', '--user', self.users[user], '--team', self.teams[team])
        self.keys = {}
        self.tokens = {}
        for name, identifier in self.users.items():
            path = self.state/(name+'.key')
            self.admin('token', '--user', identifier, '--output', str(path))
            self.keys[name] = path
            self.tokens[name] = path.read_text().strip()
        self.api = self.enterContext(running_server(ObservedTeamHandler))
        self.api.dsn, self.api.failure, self.api.lose_reply, self.api.bad_team = self.api_dsn, 0, False, None
        self.api.received = []
        self.api.disable_checks = True
        self.url = f'http://127.0.0.1:{self.api.server_port}/'
        self.client = TeamClient(self.url, self.keys['Dana'])
        self.db = self.state/'private.sqlite'
        initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (str(self.state), time.time()-20, time.time()-10))
            bind_sharing(c, self.client, self.teams['A'])

    def path(self, team, card=None):
        return '/teams/'+self.teams[team]+'/items'+('' if card is None else '/'+urllib.parse.quote(card, safe=''))

    def packet(self, identifier='same', text='APPROVED'):
        return dict(id=identifier, label='결정', text=text, quote=QUOTE, speaker='사용자')

    def test_approval_preserves_precision_with_rounded_db_default(self):
        # Keep the cloud precision regression runnable without machine-specific provisioning.
        self.api.dsn = make_conninfo(self.api_dsn, options='-c extra_float_digits=0')
        data = dict(packet=self.packet('precision-test'), approved_by=self.users['Alice'],
                    approved_at=1790000000.1234567)
        path, token = self.path('A'), self.tokens['Alice']
        self.assertEqual(request(self.api, 'POST', path, token, data)[0], 200)
        self.assertEqual(request(self.api, 'POST', path, token, data)[0], 200)
        changed = dict(data, approved_at=math.nextafter(data['approved_at'], math.inf))
        self.assertEqual(request(self.api, 'POST', path, token, changed)[0], 409)
        changed = dict(data, packet=dict(data['packet'], text='SYNTHETIC changed'))
        self.assertEqual(request(self.api, 'POST', path, token, changed)[0], 409)
        status, body = request(self.api, 'GET', path, token)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['items'], [data])

    def publish(self, user, team, identifier='same', text='APPROVED', **extra):
        data = dict(packet=self.packet(identifier, text), approved_by=self.users[user], approved_at=time.time())
        data.update(extra)
        return request(self.api, 'POST', self.path(team), self.tokens[user], data)

    def card(self, identifier='c', manual=False):
        with connect(self.db) as c:
            evidence = json.dumps([dict(n=1, role='user', text=EVIDENCE)])
            c.execute("INSERT INTO jobs VALUES(?,?,?,'')", (identifier,evidence,'failed_draft' if manual else 'done'))
            c.execute("INSERT INTO cards VALUES(?,?,'decision',1,?,?,?,?)",
                (identifier,identifier,None if manual else '승인 문구',None if manual else QUOTE,
                 None if manual else 'user','manual' if manual else 'ready'))
        return dict(id=identifier, text='승인 문구', quote=QUOTE)

    def approve(self, identifier='c'):
        fields = self.card(identifier)
        with connect(self.db) as c:
            destination = dict(c.execute('SELECT * FROM sharing').fetchone())
            delivery.approve(c, fields.__getitem__, destination)

    def deliver(self, client=None):
        return delivery.deliver(self.db, '/team-board', '', client or self.client)

    def due(self):
        with connect(self.db) as c:
            c.execute('UPDATE outbox SET next_attempt=0')

    def row(self, table='outbox', identifier='c'):
        with connect(self.db) as c:
            return dict(c.execute(f'SELECT * FROM {table} WHERE id=?', (identifier,)).fetchone())

    def review(self):
        srv = self.enterContext(running_server(app.Review))
        srv.db, srv.csrf, srv.secret, srv.team_client = self.db, 'synthetic-csrf', '', self.client
        srv.board_url = '/team-board'
        return srv

    def form(self, srv, path, **fields):
        return request(srv, 'POST', path, data=dict(csrf=srv.csrf, **fields), form=True)

    def team_request(self, method, suffix, data=None, user='Dana'):
        status, body = request(self.api, method, '/teams/'+self.teams['A']+'/'+suffix, self.tokens[user], data)
        return status, json.loads(body)

    def board_item(self, card_id):
        """Team A's board entry for one card."""
        return next(c for c in self.team_request('GET', 'board')[1]['items'] if c['id'] == card_id)

    def reapply_upgrade(self, column):
        """Drop one team_upgrades.sql column: the API must refuse to start until migrate-integration (run twice)
        restores it, and the approved cards must be untouched."""
        with psycopg.connect(self.admin_dsn) as c:
            before = c.execute('SELECT team_id,id,packet FROM syncup.shared_cards ORDER BY id').fetchall()
            c.execute(f'ALTER TABLE syncup.conflict_checks DROP COLUMN {column}')
        with self.assertRaisesRegex(ValueError, 'migrate-integration'):
            verify_database(self.api_dsn)
        self.admin('migrate-integration')
        self.admin('migrate-integration')
        verify_database(self.api_dsn)
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT team_id,id,packet FROM syncup.shared_cards ORDER BY id').fetchall(), before)

    @contextmanager
    def team_db(self, user='Dana', team='A'):
        """A transaction as `user` in `team`, under the same row-level security as the API."""
        with authorized(self.api_dsn, self.tokens[user], self.teams[team]) as (c, _user):
            yield c

    def run_due_checks(self):
        process_checks(self.api, self.tokens['Dana'], self.teams['A'])

    def settle_checks(self):
        """Mark team A's queued checks done, so only cards published afterwards are checked."""
        with self.team_db() as c:
            c.execute("UPDATE syncup.conflict_checks SET state='complete' WHERE team_id=%s", (self.teams['A'],))

    def make_check_due(self, card_id):
        """Skip the waiting time (retry delay or lease) of one card's check."""
        with self.team_db() as c:
            c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 second' WHERE card_id=%s",
                      (card_id,))

    def native_host(self, srv):
        """Register a native-messaging host for `srv`'s RPC endpoint; returns (connection file, host manifest)."""
        connection = self.state/'connection.json'
        connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc', token=srv.rpc_secret)))
        connection.chmod(0o600)
        return connection, json.loads(prepare('a'*32, connection, self.state/'native').read_text())

    def native_frame(self, registration, method, params=None):
        """Run the registered host once with one length-prefixed request, as Chrome does; returns its response."""
        payload = json.dumps(dict(version=1, method=method, params=params or {})).encode()
        done = subprocess.run([registration['path'], registration['allowed_origins'][0]],
                              input=struct.pack('=I', len(payload))+payload, capture_output=True, timeout=15)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(struct.unpack('=I', done.stdout[:4])[0], len(done.stdout)-4)
        return json.loads(done.stdout[4:])

    def test_failed_token_issue_leaves_no_key_file(self):
        path = self.state/'unknown-user.key'
        for args, message in [(['--user', str(uuid.uuid4())], 'ForeignKeyViolation'),
                              (['--user', self.users['Alice'], '--days', '91'], 'Token validity must be 1 to 90 days')]:
            with self.subTest(message=message):
                command = [sys.executable, str(ROOT/'team_admin.py'), 'token', *args, '--output', str(path)]
                failed = subprocess.run(command, env=dict(os.environ, SYNCUP_ADMIN_DATABASE_URL=self.admin_dsn),
                                        text=True, capture_output=True)
                self.assertEqual(failed.returncode, 1)
                self.assertIn(message, failed.stderr)
                self.assertFalse(path.exists())
        self.admin('token', '--user', self.users['Alice'], '--output', str(path))
        self.assertEqual(request(self.api, 'GET', '/me', path.read_text().strip())[0], 200)

    def test_api_authentication_cross_team_and_forged_approval(self):
        self.assertEqual(request(self.api,'GET','/me')[0],401)
        self.assertEqual(request(self.api,'GET','/me','x'*43)[0],401)
        status, raw = request(self.api,'GET','/me',self.tokens['Alice'])
        self.assertEqual(status,200)
        self.assertEqual([t['id'] for t in json.loads(raw)['teams']], [self.teams['A']])
        self.assertEqual(self.publish('Alice','A',text='A_ONLY')[0],200)
        self.assertEqual(self.publish('Bob','B',text='B_ONLY')[0],200)
        for method in ('GET','POST','PATCH','PUT','DELETE'):
            for card in (None,'same'):
                status,raw=request(self.api,method,self.path('B',card),self.tokens['Alice'], {} if method!='GET' else None)
                self.assertEqual(status,403)
                self.assertNotIn('B_ONLY',raw)
        self.assertEqual(self.publish('Alice','A','forged',approved_by=self.users['Bob'])[0],403)
        self.assertEqual(self.publish('Alice','A','extra',private_evidence=PRIVATE)[0],400)
        self.assertEqual(self.publish('Alice','A','same',text='changed')[0],409)
        for user,team,expected,absent in [('Alice','A','A_ONLY','B_ONLY'),('Bob','B','B_ONLY','A_ONLY')]:
            status,raw=request(self.api,'GET',self.path(team,'same'),self.tokens[user])
            self.assertEqual(status,200)
            self.assertIn(expected,raw)
            self.assertNotIn(absent,raw)

    def test_database_rls_even_without_application_filter(self):
        self.assertEqual(self.publish('Alice','A',text='A_ONLY')[0],200)
        self.assertEqual(self.publish('Bob','B',text='B_ONLY')[0],200)
        with authorized(self.api_dsn,self.tokens['Alice'],self.teams['A']) as (c,user):
            rows=c.execute('SELECT team_id::text,packet FROM syncup.shared_cards').fetchall()
            self.assertEqual([r['team_id'] for r in rows],[self.teams['A']])
            for team,owner in [('B',user),('A',self.users['Bob'])]:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege),c.transaction():
                    c.execute('''INSERT INTO syncup.shared_cards(team_id,id,approved_by,approved_at,packet)
                        VALUES(%s,'evil',%s,%s,%s)''',(self.teams[team],owner,time.time(),Jsonb(self.packet('evil'))))
            for query in ('UPDATE syncup.shared_cards SET packet=packet','DELETE FROM syncup.shared_cards',
                          'SELECT * FROM syncup.tokens','UPDATE syncup.memberships SET active=true'):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege),c.transaction():
                    c.execute(query)
            c.commit()
            self.assertEqual(c.execute('SELECT * FROM syncup.shared_cards').fetchall(), [])
        with psycopg.connect(self.api_dsn) as c:
            self.assertEqual(c.execute('SELECT * FROM syncup.shared_cards').fetchall(), [])
        with self.assertRaises(ValueError):
            verify_database(self.admin_dsn)

    def test_team_switch_stale_tab_retry_and_no_private_disclosure(self):
        review=self.review()
        fields=self.card()
        status,html=request(review,'GET','/')
        self.assertEqual(status,200)
        self.assertIn('A팀 · 이 카드 한 장 승인',html)
        self.assertNotIn(self.tokens['Dana'],html)
        self.assertEqual(self.form(review,'/approve',**fields,target_team=self.teams['A'])[0],303)
        original=self.row()
        self.api.failure=503
        self.deliver()
        self.assertEqual(self.row()['state'],'pending')
        self.assertEqual(self.form(review,'/switch-team',team_id=self.teams['B'])[0],303)
        stale=self.card('stale')
        self.assertEqual(self.form(review,'/approve',**stale,target_team=self.teams['A'])[0],400)
        with connect(self.db) as c:
            self.assertIsNone(c.execute("SELECT 1 FROM outbox WHERE id='stale'").fetchone())
        fields_b=self.card('b')
        self.assertEqual(self.form(review,'/approve',**fields_b,target_team=self.teams['B'])[0],303)
        self.api.failure=0
        self.due()
        self.deliver()
        self.deliver()
        self.assertEqual(self.row()['state'],'sent')
        self.assertEqual(self.row()['payload'],original['payload'])
        self.assertEqual(self.row('outbox_destinations')['team_id'],self.teams['A'])
        self.assertEqual([r['packet']['id'] for r in self.client.items(self.teams['A'])],['c'])
        self.assertEqual([r['packet']['id'] for r in self.client.items(self.teams['B'])],['b'])
        self.assertNotIn(PRIVATE,b''.join(self.api.received).decode())
        with psycopg.connect(self.admin_dsn) as c:
            self.assertNotIn(PRIVATE,str(c.execute('SELECT packet FROM syncup.shared_cards').fetchall()))
        status,html=request(review,'GET','/team-board')
        self.assertEqual(status,200)
        self.assertIn('B팀 · 팀 보드',html)

    def test_lost_ack_restart_and_destination_immutable(self):
        self.approve()
        original=self.row()
        self.api.lose_reply=True
        self.deliver()
        self.assertEqual(self.row()['state'],'pending')
        initialize(self.db)
        self.client=TeamClient(self.url,self.keys['Dana'])
        with connect(self.db) as c:
            bind_sharing(c,self.client,self.teams['B'])
        for query in ("UPDATE outbox_destinations SET team_id='changed'",'DELETE FROM outbox_destinations',
                      "UPDATE sharing SET user_id='changed'",'DELETE FROM sharing'):
            with self.assertRaises(sqlite3.IntegrityError),connect(self.db) as c:
                c.execute(query)
        self.due()
        self.deliver()
        self.assertEqual(self.row()['state'],'sent')
        self.assertEqual(self.row()['payload'],original['payload'])
        self.assertEqual(self.row()['created'],original['created'])
        self.assertEqual(len(self.client.items(self.teams['A'])),1)
        self.assertEqual(self.client.items(self.teams['B']),[])

    def test_membership_revocation_blocks_pending_and_manual_retry(self):
        self.approve()
        original=self.row()['payload']
        self.admin('member','--user',self.users['Dana'],'--team',self.teams['A'],'--revoke')
        with connect(self.db) as c:
            bind_sharing(c,self.client,self.teams['B'])
        self.deliver()
        self.assertEqual(self.row()['state'],'blocked')
        self.assertIn('403',self.row()['detail'])
        review=self.review()
        self.assertEqual(self.form(review,'/retry-delivery',id='c',teamId=self.teams['B'])[0],400)
        self.deliver()
        self.assertEqual(self.row()['state'],'blocked')
        self.assertEqual(self.row()['payload'],original)
        self.assertEqual(self.client.items(self.teams['B']),[])
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM syncup.shared_cards').fetchone()[0],0)

    def test_revoked_expired_and_disabled_credentials(self):
        self.admin('revoke-tokens','--user',self.users['Alice'])
        self.assertEqual(request(self.api,'GET','/me',self.tokens['Alice'])[0],401)
        with psycopg.connect(self.admin_dsn) as c:
            c.execute("UPDATE syncup.tokens SET expires_at=now()-interval '1 second' WHERE user_id=%s",(self.users['Bob'],))
            c.execute('UPDATE syncup.users SET active=false WHERE id=%s',(self.users['Dana'],))
        self.assertEqual(request(self.api,'GET','/me',self.tokens['Bob'])[0],401)
        self.approve()
        self.deliver()
        self.assertEqual(self.row()['state'],'blocked')
        self.assertIn('401',self.row()['detail'])

    def test_wrong_server_user_and_unbound_legacy_not_transmitted(self):
        self.approve()
        alice=TeamClient(self.url,self.keys['Alice'])
        with self.assertRaises(ValueError),connect(self.db) as c:
            bind_sharing(c,alice,self.teams['A'])
        self.deliver(alice)
        self.assertEqual(self.row()['state'],'blocked')
        self.assertEqual(self.api.received,[])
        changed=copy.copy(self.client)
        changed.api_url='https://different.example/'
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET state='pending'")
        self.deliver(changed)
        self.assertEqual(self.row()['state'],'blocked')
        self.assertEqual(self.api.received,[])
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET state='pending'")
        delivery.deliver(self.db,'http://127.0.0.1:1/','legacy-secret')
        self.assertEqual(self.row()['state'],'blocked')

    def test_v1_migration_preserves_local_approval_without_remote_promotion(self):
        legacy=self.state/'legacy.sqlite'
        initialize_v1(legacy)
        packet=json.dumps(self.packet('legacy'))
        with connect(legacy) as c:
            c.execute("INSERT INTO jobs VALUES('j','[]','done','')")
            c.execute("INSERT INTO cards VALUES('legacy','j','decision',1,'text','quote','user','queued')")
            c.execute("INSERT INTO outbox(id,payload,state,created) VALUES('legacy',?,'pending',?)",(packet,time.time()))
        initialize(legacy)
        initialize(legacy)
        with connect(legacy) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],2)
            self.assertEqual(c.execute('SELECT payload FROM outbox').fetchone()[0],packet)
            self.assertEqual(c.execute('SELECT count(*) FROM outbox_destinations').fetchone()[0],0)
            bind_sharing(c,self.client,self.teams['A'])
        delivery.deliver(legacy,'/team-board','',self.client)
        with connect(legacy) as c:
            self.assertEqual(c.execute('SELECT state FROM outbox').fetchone()[0],'blocked')
        backups=list(self.state.glob('legacy.sqlite.v1-*.bak.sqlite'))
        self.assertEqual(len(backups),1)
        with connect(backups[0]) as c:
            self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0],1)
            self.assertEqual(c.execute('SELECT payload FROM outbox').fetchone()[0],packet)
        self.assertEqual(self.api.received,[])

    def test_parallel_team_requests_and_invalid_input(self):
        self.assertEqual(self.publish('Alice','A',text='A_ONLY')[0],200)
        self.assertEqual(self.publish('Bob','B',text='B_ONLY')[0],200)
        def read(team):
            status,raw=request(self.api,'GET',self.path(team),self.tokens['Dana'])
            self.assertEqual(status,200)
            self.assertIn(team+'_ONLY',raw)
            self.assertNotIn(('B' if team=='A' else 'A')+'_ONLY',raw)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(read,['A','B']*10))
        self.assertEqual(request(self.api,'GET','/teams/not-a-uuid/items',self.tokens['Dana'])[0],400)
        for url in ('http://example.com/','https://example.com/?token=bad','https://user:pass@example.com/'):
            with self.assertRaises(ValueError):
                TeamClient(url,self.keys['Dana'])
        self.keys['Dana'].chmod(0o644)
        with self.assertRaises(ValueError):
            TeamClient(self.url,self.keys['Dana'])

    def test_bad_ack_keeps_pending_and_api_failure_blocks_new_approval(self):
        self.approve()
        self.api.bad_team=self.teams['B']
        self.deliver()
        self.assertEqual(self.row()['state'],'pending')
        self.api.bad_team=None
        self.due()
        self.deliver()
        self.assertEqual(self.row()['state'],'sent')
        review=self.review()
        fields=self.card('blocked')
        self.admin('revoke-tokens','--user',self.users['Dana'])
        self.assertEqual(self.form(review,'/approve',**fields,target_team=self.teams['A'])[0],503)
        with connect(self.db) as c:
            self.assertIsNone(c.execute("SELECT 1 FROM outbox WHERE id='blocked'").fetchone())

    def test_cli_restart_keeps_team_and_refuses_identity_or_mode_change(self):
        command=[sys.executable,str(ROOT/'app.py'),'run','--project',str(self.state),'--state',str(self.state),
                 '--port','0','--codex-dir',str(self.state/'empty-codex'),'--claude-dir',str(self.state/'empty-claude')]
        for wrong in ([],['--team-api',self.url,'--team-token-file',str(self.keys['Alice'])]):
            result=subprocess.run(command+wrong,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
        for _ in range(2):
            child=subprocess.Popen(command+['--team-api',self.url,'--team-token-file',str(self.keys['Dana'])],
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                status, html = request(reported_address(child, 'Review CLI', timeout=10), 'GET', '/')
                self.assertEqual(status, 200)
                self.assertIn('A팀', html)
            finally:
                child.terminate()
                child.communicate(timeout=5)

    def test_team_server_cli_refuses_unsafe_configuration_with_its_reason(self):
        unreachable = 'postgresql://syncup_api:FAKE_DO_NOT_LOG@127.0.0.1:1/syncup_test'
        for env, reason in [(dict(SYNCUP_DATABASE_URL=self.api_dsn, SYNCUP_ADMIN_DATABASE_URL=self.admin_dsn),
                             'SYNCUP_ADMIN_DATABASE_URL'),
                            (dict(SYNCUP_DATABASE_URL=self.admin_dsn), '권한이 제한된 syncup_api DB 계정으로 실행해야'),
                            (dict(SYNCUP_DATABASE_URL=unreachable), '팀 DB 연결을 확인하세요')]:
            with self.subTest(reason=reason):
                rejected = subprocess.run([sys.executable, str(ROOT/'team_server.py'), '--port', '0'],
                                          env=dict(os.environ, **env), capture_output=True, text=True, timeout=10)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn(reason, rejected.stderr)
                for secret in (self.admin_dsn, 'FAKE_DO_NOT_LOG'):
                    self.assertNotIn(secret, rejected.stderr)

    def test_team_server_cli_and_manual_review(self):
        self.assertEqual(self.publish('Alice', 'A', 'cli')[0], 200)
        with team_api_process(dict(os.environ, SYNCUP_DATABASE_URL=self.api_dsn)) as cli:
            cli_client = TeamClient(f'http://127.0.0.1:{cli.server_port}/', self.keys['Alice'])
            self.assertEqual(cli_client.user_id, self.users['Alice'])
            # The started script must answer refusals itself instead of dropping the connection.
            team = '/teams/'+self.teams['A']
            for method, path, data, expected in [('GET', team+'/unknown', None, 404),
                                                 ('POST', team+'/items/cli/retry-check', {}, 409)]:
                status, body = request(cli, method, path, self.tokens['Alice'], data)
                self.assertEqual(status, expected)
                self.assertIn('error', json.loads(body))
        self.card('manual', manual=True)
        review=self.review()
        self.assertEqual(self.form(review,'/approve',id='manual',text='수동 검토 후 승인',
                                  source='1',target_team=self.teams['A'])[0],303)
        self.deliver()
        items=self.client.items(self.teams['A'])
        self.assertEqual(items[0]['packet']['text'],'수동 검토 후 승인')
        # A manual approval shares the whole evidence sentence the reviewer picked.
        self.assertEqual(items[0]['packet']['quote'],EVIDENCE)
        with connect(self.db) as c:
            self.assertEqual(c.execute("SELECT state FROM jobs WHERE id='manual'").fetchone()[0],'done')


if __name__=='__main__':
    unittest.main(verbosity=2)
