"""The native host's setup.* (collector/key_setup.py) without Docker: a loopback stand-in for the team server's POST /keys
and GET /me, the real registered launcher, and the Windows ACL path simulated as in check_windows_support.py.
Synthetic keys only; check_web_keys.py runs the same flow against real PostgreSQL and the real team API."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import base64
from contextlib import closing, contextmanager
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

import key_setup
from prepare_native import prepare
import private_files
import windows_security

ROOT = repo_paths.REPO
APP = ROOT / 'collector' / 'app.py'
USER = str(uuid.uuid4())


class FakeKeys(http.server.BaseHTTPRequestHandler):
    """POST /keys registers a digest for USER; GET /me answers for a key whose digest was registered."""

    def log_message(self, *args):
        pass

    def answer(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.bodies.append(body)
        if self.server.drop_first:
            self.server.drop_first = False
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.server.status != 200:
            return self.answer(self.server.status, dict(error='합성 거절'))
        self.server.digests.add(body['digest'])
        self.answer(200, dict(user_id=self.server.user, name='테스트', expires_at='2026-12-15T00:00:00+00:00'))

    def do_GET(self):
        key = self.headers.get('Authorization', '').removeprefix('Bearer ')
        if self.path != '/me' or hashlib.sha256(key.encode()).hexdigest() not in self.server.digests:
            return self.answer(401, dict(error='no'))
        self.answer(200, dict(user_id=self.server.user, name='테스트', teams=[dict(id=str(uuid.uuid4()), name='팀 A')]))


@contextmanager
def fake_keys_api():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeKeys)
    srv.url = f'http://127.0.0.1:{srv.server_port}/'
    srv.bodies, srv.digests, srv.status, srv.drop_first, srv.user = [], set(), 200, False, USER
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


def challenge(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()


class KeySetup(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='syncup-key-setup-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.state = self.root / 'state'
        self.api = self.enterContext(fake_keys_api())
        manifest = prepare('a' * 32, self.state / 'connection.json', self.root / 'native', self.api.url)
        self.registration = json.loads(manifest.read_text())

    def host(self, method, **params):
        """One length-prefixed request through the registered launcher, as Chrome sends it."""
        payload = json.dumps(dict(version=1, method=method, params=params)).encode()
        done = subprocess.run([self.registration['path'], self.registration['allowed_origins'][0]],
                              input=struct.pack('=I', len(payload)) + payload, capture_output=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout[4:])

    def login(self):
        """setup.begin, then the code a GitHub login would bring back; returns (setup.connect answer, verifier)."""
        sent = self.host('setup.begin')['result']['challenge']
        verifier = json.loads((self.state / 'login.pending').read_text())['verifier']
        self.assertEqual(sent, challenge(verifier))
        return self.host('setup.connect', code=str(uuid.uuid4())), verifier

    def leftovers(self):
        return sorted(p.name for p in self.state.glob('.*.new'))

    def test_begin_and_connect_keep_the_key_and_verifier_on_this_pc(self):
        self.assertEqual(self.host('setup.status')['result'], dict(hostReady=True, keyPresent=False, expiresAt=None))
        self.assertFalse(self.state.exists())  # status creates nothing
        answer, verifier = self.login()
        self.assertEqual(answer, dict(ok=True, result=dict(name='테스트', teams=['팀 A'], expiresAt='2026-12-15T00:00:00+00:00')))
        key = (self.state / 'team.key').read_text().strip()
        body = self.api.bodies[-1]
        self.assertEqual((body['verifier'], body['digest'], body['device']),
                         (verifier, hashlib.sha256(key.encode()).hexdigest(), 'macOS'))
        self.assertNotIn(key, json.dumps(self.api.bodies))  # only the digest leaves the PC
        self.assertNotIn('replaces', body)
        for name in ('team.key', 'team.json', '.gitignore'):
            self.assertEqual(stat.S_IMODE((self.state / name).stat().st_mode), 0o600, name)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        self.assertEqual(json.loads((self.state / 'team.json').read_text()),
                         dict(api_url=self.api.url, user_id=USER, expires_at='2026-12-15T00:00:00+00:00'))
        self.assertFalse((self.state / 'login.pending').exists())
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.host('setup.status')['result']['keyPresent'], True)
        # The code is redeemed once: a second connect without a new begin starts over.
        self.assertEqual(self.host('setup.connect', code=str(uuid.uuid4())), dict(ok=False, error=key_setup.START_AGAIN))
        # Logging in again replaces this PC's key, naming the old one so the server revokes only it.
        again, _ = self.login()
        self.assertTrue(again['ok'])
        self.assertEqual(self.api.bodies[-1]['replaces'], hashlib.sha256(key.encode()).hexdigest())
        self.assertNotEqual((self.state / 'team.key').read_text().strip(), key)

    def test_a_lost_answer_is_retried_once_with_the_same_digest(self):
        self.api.drop_first = True
        answer, _ = self.login()
        self.assertTrue(answer['ok'], answer)
        self.assertEqual(len(self.api.bodies), 2)
        self.assertEqual(self.api.bodies[0], self.api.bodies[1])

    def test_refusals_leave_no_key_and_say_what_to_do(self):
        for status in (401, 403, 404, 409, 429, 500):
            with self.subTest(status=status):
                self.api.status = status
                answer, verifier = self.login()
                self.assertEqual(answer, dict(ok=False, error=key_setup.ANSWERS.get(status, key_setup.SERVER_FAILED)))
                self.assertNotIn(verifier, json.dumps(answer))
                self.assertFalse((self.state / 'team.key').exists())
                self.assertEqual(self.leftovers(), [])
        self.api.status = 200
        self.api.user = str(uuid.uuid4())
        self.assertTrue(self.login()[0]['ok'])
        self.api.user = str(uuid.uuid4())  # a code for another SyncUp user cannot take this PC over
        self.assertEqual(self.login()[0], dict(ok=False, error=key_setup.OTHER_USER))

    def test_state_folders_others_can_read_or_bound_elsewhere_are_refused(self):
        self.state.mkdir(mode=0o755)
        self.state.chmod(0o755)
        self.assertEqual(self.host('setup.begin'), dict(ok=False, error=key_setup.FOLDER))
        self.state.chmod(0o700)
        with closing(sqlite3.connect(self.state / 'private.sqlite')) as c:  # a collector already bound elsewhere
            c.execute('CREATE TABLE sharing(id INTEGER PRIMARY KEY, api_url TEXT, user_id TEXT, team_id TEXT)')
            c.execute("INSERT INTO sharing VALUES(1,'https://other.invalid/',?,NULL)", (USER,))
            c.commit()
        self.assertEqual(self.login()[0], dict(ok=False, error=key_setup.OTHER_SERVER))
        self.assertEqual(self.api.bodies, [])

    def test_a_host_registered_without_team_api_says_how_to_fix_it(self):
        manifest = prepare('b' * 32, self.state / 'connection.json', self.root / 'native-old')
        self.registration = json.loads(manifest.read_text())
        self.assertEqual(self.host('setup.connect', code=str(uuid.uuid4())), dict(ok=False, error=key_setup.NO_TEAM_API))
        with self.assertRaises(ValueError):
            prepare('c' * 32, self.state / 'connection.json', self.root / 'native-bad', 'http://team.example.com')

    def test_collector_uses_team_json_and_refuses_one_others_can_read(self):
        self.assertTrue(self.login()[0]['ok'])
        command = [sys.executable, str(APP), 'run', '--project', str(self.root), '--state', str(self.state),
                   '--port', '0', '--codex-dir', str(self.root / 'none'), '--claude-dir', str(self.root / 'none')]
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            self.assertIn('팀 연결 확인됨', child.stdout.readline())
        finally:
            child.terminate()
            child.communicate(timeout=5)
        (self.state / 'team.json').chmod(0o644)
        refused = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('team.json은 현재 사용자만', refused.stderr)
        self.assertEqual(self.host('setup.status')['result']['keyPresent'], False)


class WindowsPath(unittest.TestCase):
    """key_setup's Windows branch with the ACL calls simulated; the ACL rules themselves are in check_windows_support."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='syncup-key-setup-win-')
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name).resolve()

    def test_the_state_folder_gets_or_must_have_an_owner_only_acl(self):
        state = self.folder / 'state'
        with patch.object(sys, 'platform', 'win32'), \
                patch.object(windows_security, 'restrict_to_current_user') as restrict, \
                patch.object(windows_security, 'is_private', return_value=True):
            key_setup.prepare_state(state)
        restrict.assert_called_once_with(state)  # a new empty folder gets the ACL its files then inherit
        self.assertEqual((state / '.gitignore').read_text(), '*\n')
        with patch.object(sys, 'platform', 'win32'), \
                patch.object(windows_security, 'is_private_path', return_value=False):
            with self.assertRaises(key_setup.SetupError) as refused:
                key_setup.prepare_state(state)  # a used folder others can read is never re-permissioned
        self.assertEqual(str(refused.exception), key_setup.FOLDER)

    def test_a_file_the_acl_lets_others_read_is_removed_not_used(self):
        with patch.object(sys, 'platform', 'win32'), patch.object(os, 'O_NOFOLLOW', 0, create=True), \
                patch.object(windows_security, 'is_private', return_value=False) as check:
            with self.assertRaises(key_setup.SetupError):
                key_setup.new_private_file(self.folder, 'team.key', 'k' * 43 + '\n')
        check.assert_called_once()
        self.assertEqual(list(self.folder.iterdir()), [])
        with patch.object(sys, 'platform', 'win32'), patch.object(windows_security, 'is_private', return_value=True):
            written = key_setup.new_private_file(self.folder, 'team.key', 'k' * 43 + '\n')
            self.assertEqual(private_files.read_private_file(written, 64, 'x'), b'k' * 43 + b'\n')

    def test_replacing_a_file_another_program_holds_is_retried_on_windows_only(self):
        source = self.folder / 'new'
        source.write_text('x')
        failing = [PermissionError(13, 'in use')] * 2
        real_replace = os.replace

        def replace(a, b):
            if failing:
                raise failing.pop()
            real_replace(a, b)
        with patch.object(sys, 'platform', 'win32'), patch.object(key_setup.os, 'replace', side_effect=replace), \
                patch.object(key_setup.time, 'sleep') as sleep:
            key_setup.replace_file(source, self.folder / 'team.key')
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual((self.folder / 'team.key').read_text(), 'x')
        with patch.object(sys, 'platform', 'darwin'), \
                patch.object(key_setup.os, 'replace', side_effect=PermissionError(13, 'in use')):
            with self.assertRaises(PermissionError):
                key_setup.replace_file(self.folder / 'team.key', self.folder / 'other')

    def test_windows_hosts_name_their_device(self):
        captured = {}

        def register(team_api, body):
            captured.update(body)
            raise key_setup.SetupError('stop')
        state = self.folder / 'state'
        with patch.object(sys, 'platform', 'win32'), patch.object(windows_security, 'restrict_to_current_user'), \
                patch.object(windows_security, 'is_private', return_value=True), \
                patch.object(windows_security, 'is_private_path', return_value=True), \
                patch.object(key_setup, 'register', side_effect=register):
            key_setup.begin(state)
            with self.assertRaises(key_setup.SetupError):
                key_setup.connect(state, 'https://team.example.com', str(uuid.uuid4()))
        self.assertEqual(captured['device'], 'Windows')
        self.assertEqual(sorted(p.name for p in state.iterdir()), ['.gitignore'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
