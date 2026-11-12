"""Real Chrome on Windows reaching the SyncUp native host. A test extension (windows_chrome_probe/) sends one request
the way the real extension does. Chrome looks the host up in the registry and starts the launcher with its own command
line; the host relays the request to a collector stand-in, and the answer comes back to the extension.

Needs Windows and Chrome in CHROME_PATH. Use Chrome for Testing: stable Chrome no longer loads an unpacked extension
from the command line. .github/workflows/windows.yml installs it. Uses the packaged app (dist/syncup/syncup.exe) when
it is built, else the source. The per-user registry entry of com.syncup.collector is replaced while the check runs and
put back afterwards.
"""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import prepare_native
import private_files
from secure_http import LoopbackServer

ROOT = Path(__file__).resolve().parent
PROBE = ROOT / 'windows_chrome_probe'
BUNDLE_EXE = ROOT / 'dist' / 'syncup' / 'syncup.exe'
CHROME = os.environ.get('CHROME_PATH', '')
# Chrome, Chrome for Testing and Chromium each read their own key.
PRODUCTS = ('Google\\Chrome', 'Google\\Chrome for Testing', 'Chromium')
TOKEN = 't' * 43
COLLECTOR_ANSWER = {'ok': True, 'probe': 'collector'}


def probe_extension_id():
    """Chrome's ID for an extension whose manifest has this public key."""
    key = json.loads((PROBE / 'manifest.json').read_text(encoding='utf-8'))['key']
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


class Recorder(http.server.BaseHTTPRequestHandler):
    """Stands in for the collector (/rpc) and receives the extension's report (/report)."""

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'null')
        self.server.records.append((self.path, self.headers.get('Authorization'), body))
        data = json.dumps(COLLECTOR_ANSWER if self.path == '/rpc' else {}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@unittest.skipUnless(sys.platform == 'win32' and CHROME, 'needs Windows and CHROME_PATH (Chrome for Testing)')
class RealChrome(unittest.TestCase):
    def setUp(self):
        import winreg
        self.winreg = winreg
        temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)  # Chrome may still hold profile files
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.server = LoopbackServer(('127.0.0.1', 0), Recorder)
        self.server.records = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        state = self.root / 'state'
        private_files.make_private_directory(state)
        self.connection = state / 'connection.json'
        self.connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{self.server.server_port}/rpc', token=TOKEN)))
        self.extension_id = probe_extension_id()
        self.manifest = self.native_setup(self.root / 'native')
        self.keep_registry()

    def native_setup(self, output):
        """The manifest path, from the packaged app if it is built, as a user would make it."""
        if BUNDLE_EXE.exists():
            done = subprocess.run([str(BUNDLE_EXE), 'native-setup', '--extension-id', self.extension_id,
                                   '--connection', str(self.connection), '--output', str(output)],
                                  capture_output=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr.decode('utf-8', 'replace'))
            return Path(done.stdout.decode('utf-8').splitlines()[0])
        return prepare_native.prepare(self.extension_id, self.connection, output)

    def keep_registry(self):
        """Put back whatever com.syncup.collector entries were there before."""
        winreg = self.winreg
        for product in PRODUCTS:
            path = f'Software\\{product}\\NativeMessagingHosts\\{prepare_native.HOST_NAME}'
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
                    before = winreg.QueryValueEx(key, '')[0]
            except OSError:
                before = None

            def restore(path=path, before=before):
                if before is None:
                    try:
                        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
                    except OSError:
                        pass
                else:
                    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, path) as key:
                        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, before)
            self.addCleanup(restore)

    def register(self, manifest):
        """What the printed `reg add` command does, for each Chrome product."""
        winreg = self.winreg
        for product in PRODUCTS:
            path = f'Software\\{product}\\NativeMessagingHosts\\{prepare_native.HOST_NAME}'
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, path) as key:
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(manifest))

    def run_chrome(self, name):
        """Start Chrome with the probe extension until it reports; returns the report."""
        extension = self.root / f'{name}-extension'
        shutil.copytree(PROBE, extension)
        (extension / 'config.js').write_text(
            f"self.PROBE_REPORT_URL = 'http://127.0.0.1:{self.server.server_port}/report';\n", encoding='utf-8')
        log = (self.root / f'{name}-chrome.log').open('wb')
        self.addCleanup(log.close)
        chrome = subprocess.Popen([CHROME, '--headless=new', f'--user-data-dir={self.root / (name + "-profile")}',
                                   f'--load-extension={extension}', '--no-first-run', '--no-default-browser-check',
                                   '--disable-gpu', '--enable-logging=stderr', 'about:blank'],
                                  stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                reports = [body for path, _, body in self.server.records if path == '/report']
                if reports:
                    return reports[0]
                time.sleep(.5)
            log.flush()
            tail = (self.root / f'{name}-chrome.log').read_bytes()[-3000:].decode('utf-8', 'replace')
            self.fail('the probe extension never reported; Chrome log tail:\n' + tail)
        finally:
            subprocess.run(['taskkill', '/PID', str(chrome.pid), '/T', '/F'], capture_output=True)
            chrome.wait(timeout=30)

    def test_chrome_starts_the_registered_host_and_gets_the_collector_s_answer(self):
        self.register(self.manifest)
        report = self.run_chrome('direct')
        self.assertEqual(report, {'answer': COLLECTOR_ANSWER})
        rpc = [(auth, body) for path, auth, body in self.server.records if path == '/rpc']
        self.assertEqual(rpc, [('Bearer ' + TOKEN, {'version': 1, 'method': 'status', 'params': {}})])

    def test_the_command_line_chrome_starts_the_host_with(self):
        """Wraps the launcher in one that records %CMDCMDLINE%, the command line cmd.exe was started with."""
        launcher = json.loads(self.manifest.read_text(encoding='utf-8'))['path']
        recorded = self.root / 'cmdcmdline.txt'
        wrapper = self.root / 'native' / 'record-command-line.cmd'
        # Delayed expansion, so that the < and > of Chrome's pipe redirection in the recorded line stay text.
        wrapper.write_bytes((f'@echo off\r\nsetlocal EnableDelayedExpansion\r\n>"{recorded}" echo(!CMDCMDLINE!\r\n'
                             f'endlocal\r\ncall "{launcher}" %*\r\n').encode(prepare_native.CMD_ENCODING))
        manifest = self.root / 'native' / 'wrapped.json'
        manifest.write_text(json.dumps({**json.loads(self.manifest.read_text(encoding='utf-8')), 'path': str(wrapper)}),
                            encoding='utf-8')
        self.register(manifest)
        self.assertEqual(self.run_chrome('wrapped'), {'answer': COLLECTOR_ANSWER})
        command_line = recorded.read_text(errors='replace').strip()
        print('\nChrome started the native host with:', command_line, file=sys.stderr)
        self.assertIn('cmd.exe', command_line.lower())
        self.assertIn(f'chrome-extension://{self.extension_id}/', command_line)
        self.assertIn(str(wrapper), command_line)


if __name__ == '__main__':
    # The workflow sets this, so that a missing Chrome cannot pass as skipped checks.
    if os.environ.get('SYNCUP_REQUIRE_CHROME') and not (sys.platform == 'win32' and Path(CHROME).is_file()):
        raise SystemExit('CHROME_PATH에 Chrome for Testing이 없습니다.')
    unittest.main(verbosity=2)
