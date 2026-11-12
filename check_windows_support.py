"""Windows support of the local collector.

Everywhere: the ACL rule as plain data, and private files, the native host launcher and the port with the Windows API
replaced by a test double. On Windows itself (.github/workflows/windows.yml) also the real ACLs and the real launcher
through cmd.exe.
"""
import http.server
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, call, patch
import urllib.request

import app
import native_host
import prepare_native
import private_files
from secure_http import LoopbackServer
import windows_security
from windows_security import ADMINISTRATORS, LOCAL_SYSTEM, OWNER_RIGHTS, private_acl

USER = 'S-1-5-21-1-2-3-1001'
OTHER_USER = 'S-1-5-21-1-2-3-1002'
EVERYONE = 'S-1-1-0'
USERS = 'S-1-5-32-545'
ALLOW, DENY = 0, 1
INHERITED, INHERIT_ONLY = 0x10, 0x8
EXTENSION = 'a' * 32
ORIGIN = f'chrome-extension://{EXTENSION}/'


class Answer(http.server.BaseHTTPRequestHandler):
    """Answers every request with {} (HTTP/1.0, so the server closes each connection first)."""

    def log_message(self, *args):
        pass

    def answer(self):
        if self.command == 'POST':
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')

    do_GET = do_POST = answer


class PrivateAcl(unittest.TestCase):
    """The ACL rule that stands in for POSIX mode 600 and the owner check."""

    def test_user_profile_and_state_folder_acls_are_private(self):
        profile = [(ALLOW, INHERITED, LOCAL_SYSTEM), (ALLOW, INHERITED, ADMINISTRATORS), (ALLOW, INHERITED, USER)]
        state = [(ALLOW, INHERITED, USER), (ALLOW, INHERITED, LOCAL_SYSTEM)]
        # What os.mkdir(path, 0o700), and so tempfile.mkdtemp, gives a folder on Windows.
        python_private = [(ALLOW, INHERITED, LOCAL_SYSTEM), (ALLOW, INHERITED, ADMINISTRATORS),
                          (ALLOW, INHERITED, OWNER_RIGHTS)]
        self.assertTrue(private_acl(USER, profile, USER))
        self.assertTrue(private_acl(USER, state, USER))
        self.assertTrue(private_acl(USER, python_private, USER))
        self.assertTrue(private_acl(ADMINISTRATORS, state, USER), 'created while elevated')

    def test_other_accounts_and_missing_acls_are_refused(self):
        for sid in (OTHER_USER, EVERYONE, USERS):
            with self.subTest(sid=sid):
                self.assertFalse(private_acl(USER, [(ALLOW, 0, USER), (ALLOW, INHERITED, sid)], USER))
        self.assertFalse(private_acl(USER, None, USER), 'a NULL DACL admits everyone')
        self.assertFalse(private_acl(OTHER_USER, [(ALLOW, 0, USER)], USER), 'owned by another user')
        self.assertFalse(private_acl(USER, [(ALLOW, 0, USER), (5, 0, None)], USER), 'an unknown entry type')

    def test_deny_and_inherit_only_entries_admit_no_one(self):
        self.assertTrue(private_acl(USER, [(DENY, 0, None), (ALLOW, INHERIT_ONLY, EVERYONE), (ALLOW, 0, USER)], USER))


class SimulatedWindowsFiles(unittest.TestCase):
    """private_files and app.main on Windows, with the Windows API replaced by a test double."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.key = self.folder / 'team.key'
        self.key.write_bytes(b'k' * 43 + b'\r\n')

    def read(self, path):
        return private_files.read_private_file(path, 256, 'not private')

    def test_the_acl_decides_instead_of_the_mode(self):
        self.key.chmod(0o644)
        with patch.object(sys, 'platform', 'win32'):
            with patch.object(windows_security, 'is_private', return_value=True) as check:
                self.assertEqual(self.read(self.key), b'k' * 43 + b'\r\n')
            check.assert_called_once()
            with patch.object(windows_security, 'is_private', return_value=False):
                with self.assertRaisesRegex(ValueError, 'not private'):
                    self.read(self.key)

    def test_links_are_refused_before_opening(self):
        link = self.folder / 'link.key'
        try:
            link.symlink_to(self.key)
        except OSError:
            self.skipTest('creating a link needs a permission this account lacks')
        # Without O_NOFOLLOW, as on Windows, only the check before opening refuses the link.
        with patch.object(sys, 'platform', 'win32'), patch.object(os, 'O_NOFOLLOW', 0, create=True), \
                patch.object(windows_security, 'is_private', return_value=True) as check:
            with self.assertRaises(OSError):
                self.read(link)
        check.assert_not_called()

    def test_only_windows_gives_an_empty_state_folder_an_acl(self):
        with patch.object(windows_security, 'restrict_to_current_user') as restrict:
            with patch.object(sys, 'platform', 'darwin'):
                private_files.make_private_directory(self.folder / 'mac' / 'state')
            restrict.assert_not_called()
            with patch.object(sys, 'platform', 'win32'):
                private_files.make_private_directory(self.folder / 'windows' / 'state')
            restrict.assert_called_once_with(self.folder / 'windows' / 'state')
        self.assertTrue((self.folder / 'windows' / 'state').is_dir())

    def test_a_used_folder_keeps_its_acl_and_must_already_be_private(self):
        # self.folder holds team.key: its ACL is checked, never replaced.
        with patch.object(sys, 'platform', 'win32'), \
                patch.object(windows_security, 'restrict_to_current_user') as restrict:
            with patch.object(windows_security, 'is_private_path', return_value=True) as check:
                private_files.make_private_directory(self.folder)
            check.assert_called_once_with(self.folder)
            with patch.object(windows_security, 'is_private_path', return_value=False):
                with self.assertRaises(PermissionError):
                    private_files.make_private_directory(self.folder)
        restrict.assert_not_called()

    def test_app_stops_when_the_state_folder_cannot_be_made_private(self):
        argv = ['app.py', 'board', '--state', str(self.folder / 'state')]
        with patch.object(sys, 'argv', argv), patch.object(app, 'make_private_directory', side_effect=OSError), \
                patch.object(os, 'umask'), patch.object(app.signal, 'signal'):
            with self.assertRaisesRegex(SystemExit, '현재 사용자 전용'):
                app.main()


class WindowsLauncher(unittest.TestCase):
    """The .cmd file Chrome runs on Windows, written here with a known code page in place of the console's."""

    PROFILE = 'C:\\Users\\김단비'

    def test_arguments_survive_cmd_exe(self):
        cases = {
            self.PROFILE + '\\AppData\\Local\\Programs\\Python\\Python312\\python.exe':
                '"%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python312\\python.exe"',
            'c:\\users\\김단비\\syncup\\100%\\connection.json': '"%USERPROFILE%\\syncup\\100%%\\connection.json"',
            'D:\\work & play\\native_host.py': '"D:\\work & play\\native_host.py"',
            self.PROFILE + '2\\other.py': '"C:\\Users\\김단비2\\other.py"',
            EXTENSION: f'"{EXTENSION}"',
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(prepare_native.cmd_argument(value, self.PROFILE), expected)
        for value in ('C:\\a"b', 'C:\\a\nb'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                prepare_native.cmd_argument(value, self.PROFILE)

    def test_prepare_writes_a_cmd_launcher_and_its_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'native'
            with patch.object(sys, 'platform', 'win32'), patch.object(prepare_native, 'CMD_ENCODING', 'cp949'), \
                    patch.object(windows_security, 'restrict_to_current_user') as restrict:
                manifest = json.loads(prepare_native.prepare(EXTENSION, Path(temp) / 'connection.json', output).read_text())
            restrict.assert_called_once_with(output)  # no other account may replace what Chrome runs
            launcher = output / 'syncup-native.cmd'
            self.assertEqual(manifest['path'], str(launcher.resolve()))
            self.assertEqual(manifest['allowed_origins'], [ORIGIN])
            lines = launcher.read_bytes().decode('cp949').split('\r\n')
            self.assertEqual(lines[:2], ['@echo off', 'setlocal DisableDelayedExpansion'])
            self.assertIn('"--connection"', lines[2])
            self.assertTrue(lines[2].endswith(f' "--extension-id" "{EXTENSION}" %*'))
            self.assertEqual(lines[3:], [''])

    def test_paths_the_code_page_cannot_hold_are_refused_before_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / '한글'
            with patch.object(sys, 'platform', 'win32'), patch.object(prepare_native, 'CMD_ENCODING', 'ascii'), \
                    patch.dict(os.environ, {'USERPROFILE': ''}), patch.object(windows_security, 'restrict_to_current_user'):
                with self.assertRaisesRegex(ValueError, '영문 경로'):
                    prepare_native.prepare(EXTENSION, output / 'connection.json', output)
            self.assertFalse((output / 'syncup-native.cmd').exists())

    def test_registration_is_for_the_current_user(self):
        command = prepare_native.registration_command(Path('native') / 'com.syncup.collector.json')
        self.assertTrue(command.startswith('reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\'
                                           'com.syncup.collector" /ve /t REG_SZ /d "'))
        self.assertTrue(command.endswith('com.syncup.collector.json" /f'))


class WindowsPython(unittest.TestCase):
    """What a plain Windows Python lacks or writes differently."""

    def test_the_app_starts_without_a_time_zone_database(self):
        # Windows has no system tz database; zoneinfo would need the extra tzdata package.
        code = 'import app, collector, batch_classification; from ai.syncup_ai.classify import source_of; ' \
               'print(source_of({"site": "chatgpt", "collectedAt": "2026-11-06T12:10:00Z"}))'
        done = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, encoding='utf-8',
                              cwd=Path(__file__).parent, env={**os.environ, 'PYTHONTZPATH': os.devnull}, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), 'ChatGPT, 2026-11-06 21:10')

    def test_a_key_file_saved_with_a_byte_order_mark_is_read(self):
        from team_client import TeamClient
        with tempfile.TemporaryDirectory() as temp:
            key = Path(temp) / 'team.key'
            key.write_bytes('﻿'.encode() + b'k' * 43 + b'\r\n')
            key.chmod(0o600)
            with patch.object(windows_security, 'is_private', return_value=True):
                client = TeamClient('https://team.invalid', key, user_id='00000000-0000-4000-8000-000000000001')
        self.assertEqual(client.token, 'k' * 43)


class NativeHostArguments(unittest.TestCase):
    def run_host(self, *args):
        with tempfile.TemporaryDirectory() as temp:
            command = [sys.executable, native_host.__file__, '--connection', str(Path(temp) / 'connection.json'),
                       '--extension-id', EXTENSION, *args]
            return subprocess.run(command, input=b'', capture_output=True, timeout=10)

    def test_the_parent_window_chrome_adds_on_windows_is_accepted(self):
        for args in ([ORIGIN], [ORIGIN, '--parent-window=0'], ['--parent-window=1234', ORIGIN]):
            with self.subTest(args=args):
                self.assertEqual(self.run_host(*args).returncode, 0)
        self.assertNotEqual(self.run_host('chrome-extension://' + 'b' * 32 + '/', '--parent-window=0').returncode, 0)


class LoopbackPort(unittest.TestCase):
    def test_a_second_server_cannot_take_a_port_in_use(self):
        first = LoopbackServer(('127.0.0.1', 0), http.server.BaseHTTPRequestHandler)
        self.addCleanup(first.server_close)
        with self.assertRaises(OSError):
            LoopbackServer(('127.0.0.1', first.server_port), http.server.BaseHTTPRequestHandler).server_close()

    def test_windows_does_not_share_the_port(self):
        server = LoopbackServer(('127.0.0.1', 0), http.server.BaseHTTPRequestHandler, bind_and_activate=False)
        server.socket.close()
        server.socket = Mock()
        server.socket.getsockname.return_value = ('127.0.0.1', 1)
        with patch.object(sys, 'platform', 'win32'):
            server.server_bind()
        self.assertNotIn(call(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1), server.socket.setsockopt.call_args_list)
        server.socket.bind.assert_called_once_with(('127.0.0.1', 0))

    def test_a_stopped_server_s_port_can_be_taken_again_at_once(self):
        first = LoopbackServer(('127.0.0.1', 0), Answer)
        port = first.server_port
        threading.Thread(target=first.serve_forever, daemon=True).start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}/', timeout=10) as response:  # leaves a closed connection behind
            self.assertEqual(response.read(), b'{}')
        first.shutdown()
        first.server_close()
        LoopbackServer(('127.0.0.1', port), Answer).server_close()


@unittest.skipUnless(sys.platform == 'win32', 'needs Windows')
class RealWindows(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # Characters cmd.exe treats specially, so the launcher's quoting runs for real.
        self.folder = Path(temp.name) / 'a & b 100%'
        self.state = self.folder / 'state'

    def share_with_everyone(self, path):
        subprocess.run(['icacls', str(path), '/grant', f'*{EVERYONE}:(R)'], check=True, capture_output=True)

    def test_files_in_the_state_folder_stay_private_until_shared(self):
        self.assertRegex(windows_security.current_user_sid(), r'^S-1-5-')
        private_files.make_private_directory(self.state)
        secret = self.state / 'connection.json'
        secret.write_text('{}')
        self.assertEqual(private_files.read_private_file(secret, 10, 'not private'), b'{}')
        self.share_with_everyone(secret)
        with self.assertRaisesRegex(ValueError, 'not private'):
            private_files.read_private_file(secret, 10, 'not private')

    def test_a_used_folder_others_can_read_is_refused(self):
        private_files.make_private_directory(self.state)
        (self.state / 'private.sqlite').write_bytes(b'')
        private_files.make_private_directory(self.state)  # a used private folder is taken as it is
        self.share_with_everyone(self.state)
        with self.assertRaises(PermissionError):
            private_files.make_private_directory(self.state)

    def test_chrome_runs_the_launcher_through_cmd_exe(self):
        server = LoopbackServer(('127.0.0.1', 0), Answer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        private_files.make_private_directory(self.state)
        connection = self.state / 'connection.json'
        connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{server.server_port}/rpc', token='t' * 43)))
        manifest = json.loads(prepare_native.prepare(EXTENSION, connection, self.folder / 'native').read_text())
        payload = json.dumps(dict(version=1, method='status', params={})).encode()
        # As Chrome starts a host: cmd.exe /d /c with the whole command in one more pair of quotes.
        command = f'cmd.exe /d /c ""{manifest["path"]}" {ORIGIN} --parent-window=0"'
        done = subprocess.run(command, input=struct.pack('=I', len(payload)) + payload, capture_output=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        size = struct.unpack('=I', done.stdout[:4])[0]
        self.assertEqual(size, len(done.stdout) - 4)
        # The host read the private connection file and relayed the collector's answer, nothing else on stdout.
        self.assertEqual(json.loads(done.stdout[4:]), {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
