"""Real local scanner/configuration checks; Windows API checks below use a test double."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import argparse
from datetime import datetime, timezone
import errno
import json
import os
from pathlib import Path
import queue
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
import uuid

import scanner_runner
from local_fixtures import fake_team_api
import runtime
from storage import connect, initialize, runtime_lock


class PortabilityChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.args = argparse.Namespace(codex_dir=None, codex_sqlite_dir=None,
                                       claude_dir=None, claude_project_name=None)

    def test_storage_precedence(self):
        codex = self.root / "다른 Codex"
        codex.mkdir()
        env = {"CODEX_HOME": str(codex), "CODEX_SQLITE_HOME": str(self.root / "env-db"),
               "CLAUDE_CONFIG_DIR": str(self.root / "다른 Claude"), "CLAUDE_CODE_PROJECT_DIR_NAME": "shared-work"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(runtime.storage_paths(self.args),
                (codex, self.root / "env-db", self.root / "다른 Claude", "shared-work"))
            (codex / "config.toml").write_text('sqlite_home = "config-db"\n', encoding="utf-8")
            self.assertEqual(runtime.storage_paths(self.args)[1], codex / "config-db")
            self.args.codex_sqlite_dir = self.root / "cli-db"
            self.args.claude_dir = self.root / "cli-claude"
            self.args.claude_project_name = "cli-work"
            self.assertEqual(runtime.storage_paths(self.args)[1:],
                (self.root / "cli-db", self.root / "cli-claude", "cli-work"))
            self.args.codex_dir = self.root / "cli-codex"
            self.assertEqual(runtime.storage_paths(self.args)[0], self.args.codex_dir)
        with patch.dict(os.environ, {"CLAUDE_CODE_PROJECT_DIR_NAME": "ignored"}, clear=True), patch.object(Path, "home", return_value=self.root):
            defaults = argparse.Namespace(codex_dir=None, codex_sqlite_dir=None, claude_dir=None, claude_project_name=None)
            self.assertEqual(runtime.storage_paths(defaults), (self.root / ".codex", self.root / ".codex", self.root / ".claude", None))

    def test_invalid_configuration_is_not_silently_ignored(self):
        self.args.codex_dir = self.root
        config = self.root / "config.toml"
        for value in ('sqlite_home = 42', 'sqlite_home = ""', 'broken = ['):
            config.write_text(value, encoding="utf-8")
            with self.assertRaises(ValueError):
                runtime.storage_paths(self.args)
        self.args.codex_sqlite_dir = self.root
        for name in ("../outside", "a/b", "a\\b", "CON", "", "a" * 65):
            self.args.claude_project_name = name
            with self.assertRaises(ValueError):
                runtime.storage_paths(self.args)

    def test_child_environment_and_binary_names(self):
        with patch.dict(os.environ, {"SystemRoot": "C:\\Windows", "TEMP": "C:\\Temp", "PATH": "tools",
                                    "OPENAI_API_KEY": "synthetic-only", "HOME": "private-home"}, clear=True):
            self.assertEqual(runtime.child_environment(),
                {"SystemRoot": "C:\\Windows", "TEMP": "C:\\Temp", "PATH": "tools", "PYTHONUTF8": "1"})
        for host, binary in (("darwin", "syncup-scanner"), ("linux", "syncup-scanner"), ("win32", "syncup-scanner.exe")):
            with patch.object(sys, "platform", host):
                self.assertEqual(runtime.scanner_binary().name, binary)

    def test_windows_lock_contract_simulated(self):
        calls = []
        held = set()
        def locking(fd, mode, count):
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 0)
            self.assertEqual(count, 1)
            calls.append(mode)
            if mode == 1:
                if held:
                    raise OSError(errno.EACCES, "busy")
                held.add(fd)
            else:
                held.remove(fd)
        fake = types.SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=locking)
        with patch.dict(sys.modules, {"msvcrt": fake}), patch.object(sys, "platform", "win32"):
            with self.assertRaisesRegex(ValueError, "body"):
                with runtime_lock(self.root / "run.lock"):
                    with self.assertRaises(SystemExit):
                        with runtime_lock(self.root / "run.lock"):
                            self.fail("second owner")
                    raise ValueError("body")
            with runtime_lock(self.root / "run.lock"):
                pass
            with patch.object(fake, "locking", side_effect=OSError(errno.EIO, "I/O failure")), self.assertRaises(OSError):
                with runtime_lock(self.root / "run.lock"):
                    pass
        self.assertEqual(calls, [1, 1, 2, 1, 2])
        self.assertFalse(held)

    def fixture(self):
        project = self.root / "한글 project"
        project.mkdir()
        codex = self.root / "moved-codex"
        sessions = codex / "sessions"
        sessions.mkdir(parents=True)
        index = self.root / "separate-db"
        index.mkdir()
        claude = self.root / "moved-claude"
        folder = claude / "projects" / "custom-name"
        folder.mkdir(parents=True)
        db = self.root / "private.sqlite"
        initialize(db)
        start = time.time() - 60
        with connect(db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (str(project), start, start + 600))
        stamp = datetime.fromtimestamp(start + 10, timezone.utc).isoformat()
        def event(kind, payload):
            return dict(type=kind, timestamp=stamp, payload=payload)
        log = sessions / "main.jsonl"
        records = [event("session_meta", dict(id="main", cwd=str(project), source="cli")),
                   event("event_msg", dict(type="task_started", turn_id="turn")),
                   event("turn_context", dict(cwd=str(project))),
                   event("response_item", dict(type="message", role="user", content=[dict(type="input_text", text="새 경로 확인.")])),
                   event("response_item", dict(type="message", role="assistant", phase="final_answer", content=[dict(type="output_text", text="조사 결과입니다.")])),
                   event("event_msg", dict(type="task_complete", turn_id="turn"))]
        log.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8")
        with sqlite3.connect(index / "state_12.sqlite") as c:
            c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,created_at_ms INTEGER,cwd TEXT,archived INTEGER,source TEXT)")
            c.execute("INSERT INTO threads VALUES(?,?,?,?,0,'cli')", ("main", str(log), int((start+1)*1000), str(project)))
        # An older incompatible DB must not be used instead of the current index.
        with sqlite3.connect(index / "state_5.sqlite") as c:
            c.execute("CREATE TABLE obsolete(value TEXT)")
        session = str(uuid.uuid4())
        messages = [dict(type="user", uuid="u", parentUuid=None, message=dict(role="user", content="새 Claude 경로 확인.")),
                    dict(type="assistant", uuid="a", parentUuid="u", message=dict(role="assistant", id="answer", stop_reason="end_turn", content=[dict(type="text", text="완료했습니다.")]))]
        for message in messages:
            message.update(cwd=str(project), sessionId=session, timestamp=stamp)
        (folder / (session + ".jsonl")).write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages), encoding="utf-8")
        return db, codex, claude, index, project

    def test_relocated_roots_separate_index_and_named_claude_real_scanner(self):
        db, codex, claude, index, project = self.fixture()
        scanner_runner.scan(db, codex, claude, index, "custom-name")
        scanner_runner.scan(db, codex, claude, index, "custom-name")
        with connect(db) as c:
            rows = c.execute("SELECT evidence FROM jobs").fetchall()
            self.assertEqual(len(rows), 2)
            self.assertTrue(any("claude-code" in row[0] for row in rows))
        with sqlite3.connect(index / "state_13.sqlite") as c:
            c.execute("CREATE TABLE unknown(value TEXT)")
        with self.assertRaises(ValueError):
            scanner_runner.scan(db, codex, None, index)
        with connect(db) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM jobs").fetchone()[0], 2)

    def test_cli_uses_configured_roots_without_api_credentials(self):
        db, codex, claude, index, project = self.fixture()
        api = self.enterContext(fake_team_api(self.root))
        child = subprocess.Popen([sys.executable, str(repo_paths.REPO / "collector" / "app.py"), "run",
            "--project", str(project), "--state", str(self.root), "--port", "0",
            "--team-api", api.url, "--team-token-file", str(api.key_file),
            "--codex-dir", str(codex), "--codex-sqlite-dir", str(index), "--claude-dir", str(claude),
            "--claude-project-name", "custom-name"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", env=runtime.child_environment())
        try:
            lines = queue.Queue()
            threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
            self.assertIn("검토함", lines.get(timeout=8))
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                with connect(db) as c:
                    count = c.execute("SELECT count(*) FROM jobs").fetchone()[0]
                if count == 2:
                    break
                time.sleep(.05)
            self.assertEqual(count, 2)
        finally:
            child.terminate()
            child.communicate(timeout=5)

    @unittest.skipIf(sys.platform == "win32", "symlink creation requires Windows-specific permission")
    def test_canonical_project_alias_and_outside_log_boundary(self):
        db, codex, claude, index, project = self.fixture()
        alias = self.root / "alias"
        alias.symlink_to(project, target_is_directory=True)
        log = codex / "sessions" / "main.jsonl"
        log.write_text(log.read_text(encoding="utf-8").replace(str(project), str(alias)), encoding="utf-8")
        with sqlite3.connect(index / "state_12.sqlite") as c:
            c.execute("UPDATE threads SET cwd=?", (str(alias),))
        scanner_runner.scan(db, codex, None, index)
        with connect(db) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM jobs").fetchone()[0], 1)
        outside = self.root / "outside.jsonl"
        outside.write_bytes(log.read_bytes().replace(b'"main"', b'"outside"'))
        with sqlite3.connect(index / "state_12.sqlite") as c:
            c.execute("INSERT INTO threads SELECT 'outside',?,created_at_ms,cwd,0,source FROM threads", (str(outside),))
        scanner_runner.scan(db, codex, None, index)
        with connect(db) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM jobs").fetchone()[0], 1)

    def test_disabled_connections_before_state_creation(self):
        self.assertEqual(runtime.ENABLED_PLATFORMS, {"darwin"})
        for host in ("win32", "linux"):
            folders = [str(repo_paths.REPO / d) for d in ("collector", "contract", "")]
            code = f"import sys; sys.path[:0] = {folders!r}; import app; sys.platform = sys.argv.pop(1); app.main()"
            state = self.root / host
            result = subprocess.run([sys.executable, "-c", code, host, "run", "--state", str(state)],
                                    capture_output=True, text=True, encoding="utf-8", env=runtime.child_environment(), timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("macOS", result.stderr)
            self.assertFalse(state.exists())
        source = (repo_paths.REPO / "scanner" / "src" / "main.rs").read_text(encoding="utf-8")
        entries = re.search(r"ENABLED_OS: &\[&str\] = &\[(.*?)\];", source, re.S).group(1)
        self.assertEqual(re.findall(r'^\s*"(\w+)"', entries, re.M), ["macos"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
