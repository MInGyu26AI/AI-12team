"""The packaged Windows app, dist/syncup/syncup.exe (windows_bundle.py), run as a user and Chrome run it.

Needs Windows and the built bundle; .github/workflows/windows.yml builds it first. Elsewhere every check is skipped.
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import check_portability  # the module, not its test class, so that its own checks do not run here again
from check_windows_support import EXTENSION, native_round_trip
from local_fixtures import fake_team_api
import runtime
from storage import connect

EXE = repo_paths.REPO / 'dist' / 'syncup' / 'syncup.exe'


@unittest.skipUnless(sys.platform == 'win32' and EXE.exists(), 'needs Windows and dist/syncup/syncup.exe')
class Bundle(unittest.TestCase):
    # The same synthetic Codex and Claude Code logs check_portability scans, under a Korean project folder name.
    fixture = check_portability.PortabilityChecks.fixture

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        # As a user starts it: no Python settings, so the bundle's own encoding choices are what is checked.
        self.env = {k: v for k, v in runtime.child_environment().items() if k != 'PYTHONUTF8'}

    def test_without_a_subcommand_it_explains_its_use(self):
        done = subprocess.run([str(EXE)], capture_output=True, env=self.env, timeout=60)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('syncup.exe run', done.stderr.decode('utf-8'))

    def test_run_connects_to_the_team_and_collects_with_the_bundled_scanner(self):
        db, codex, claude, index, project = self.fixture()
        api = self.enterContext(fake_team_api(self.root))
        child = subprocess.Popen([str(EXE), 'run', '--project', str(project), '--state', str(self.root), '--port', '0',
                                  '--team-api', api.url, '--team-token-file', str(api.key_file),
                                  '--codex-dir', str(codex), '--codex-sqlite-dir', str(index),
                                  '--claude-dir', str(claude), '--claude-project-name', 'custom-name'],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        try:
            lines = queue.Queue()
            threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
            # Korean text through a pipe arrives as UTF-8 whatever the console code page is.
            self.assertIn('검토함', lines.get(timeout=60).decode('utf-8'))
            deadline = time.monotonic() + 30
            count = 0
            while time.monotonic() < deadline and count < 2:
                with connect(db) as c:
                    count = c.execute('SELECT count(*) FROM jobs').fetchone()[0]
                time.sleep(.2)
            self.assertEqual(count, 2, 'the bundled scanner read the Codex and the Claude Code log')
        finally:
            child.terminate()
            child.communicate(timeout=30)

    def test_chrome_reaches_the_collector_through_the_bundle(self):
        def setup(connection, output):
            done = subprocess.run([str(EXE), 'native-setup', '--extension-id', EXTENSION, '--connection',
                                   str(connection), '--output', str(output)], capture_output=True, env=self.env,
                                  timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr.decode('utf-8', 'replace'))
            printed = done.stdout.decode('utf-8').splitlines()
            self.assertTrue(printed[-1].startswith('reg add "HKCU\\'), printed)
            return printed[0]
        for name in ('a & b 100%', '한글 폴더'):
            with self.subTest(folder=name):
                self.assertEqual(native_round_trip(self, self.root / name, setup), {})


if __name__ == '__main__':
    # The workflow sets this, so that a bundle that failed to build cannot pass as skipped checks.
    if os.environ.get('SYNCUP_REQUIRE_BUNDLE') and not EXE.exists():
        raise SystemExit(f'{EXE} 이 없습니다: windows_bundle.py 빌드가 실패했습니다.')
    unittest.main(verbosity=2)
