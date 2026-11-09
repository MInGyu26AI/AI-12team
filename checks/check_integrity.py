"""Offline regression tests: isolated SQLite, loopback HTTP (review page, fake team API) and child processes."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import ssl
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

from collection_session import bind_sharing
import collector
import delivery
from local_fixtures import FAKE_TEAM, fake_team_api, first_line, get_page, post, server, wait_until, work_gate
from review_page import Review
from runtime import child_environment
from storage import connect, initialize, runtime_lock
from team_client import TeamClient

APP = repo_paths.REPO / "collector" / "app.py"

QUOTE = "DB는 Supabase로 확정했어."
EVIDENCE = json.dumps([dict(n=1, role="user", text=QUOTE)], ensure_ascii=False)
LEGACY = """
CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),project TEXT,start REAL,end REAL,paused INTEGER,status TEXT);
CREATE TABLE cursors(chat TEXT PRIMARY KEY,pos INTEGER);
CREATE TABLE pauses(start REAL PRIMARY KEY,end REAL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,evidence TEXT,state TEXT,detail TEXT);
CREATE TABLE cards(id TEXT PRIMARY KEY,job TEXT,kind TEXT,adopted INTEGER,draft TEXT,quote TEXT,role TEXT,status TEXT);
"""


class IntegrityFixture(unittest.TestCase):
    """A private database with an ended session, bound to the fake team API's team; cards are added per test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.db = self.root / "private.sqlite"
        self.api = self.enterContext(fake_team_api(self.root))
        self.client = TeamClient(self.api.url, self.api.key_file)
        initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (str(self.root), time.time()-20, time.time()-10))
            bind_sharing(c, self.client, FAKE_TEAM)

    def card(self, name="c", manual=False):
        with connect(self.db) as c:
            c.execute("INSERT INTO jobs VALUES(?,?,?,'')", (name, EVIDENCE, "failed_draft" if manual else "done"))
            c.execute("INSERT INTO cards VALUES(?,?,'decision',1,?,?,?,?)",
                      (name, name, None if manual else "original draft", None if manual else QUOTE,
                       None if manual else "user", "manual" if manual else "ready"))
        return dict(id=name, text="승인한 최종 문구", quote=QUOTE, source="1")

    def approve(self, fields):
        """Approve one card for the bound team, as the review page does."""
        with connect(self.db) as c:
            c.execute("BEGIN IMMEDIATE")
            delivery.approve(c, fields.__getitem__, dict(c.execute("SELECT * FROM sharing").fetchone()))

    def deliver(self):
        return delivery.deliver(self.db, self.client)

    def review(self):
        """This folder's review page connected to the fake team API, as `app.py run --team-api …` serves it."""
        srv = self.enterContext(server(Review, self.db))
        srv.team_client = self.client
        return srv

    def row(self, table, name="c"):
        with connect(self.db) as c:
            return dict(c.execute(f"SELECT * FROM {table} WHERE id=?", (name,)).fetchone())

    def due(self):
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET next_attempt=0")


class Integrity(IntegrityFixture):
    def test_approval_atomic_and_immutable(self):
        fields = self.card()
        with connect(self.db) as c:
            c.execute("CREATE TRIGGER fail_approval BEFORE UPDATE ON cards BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.approve(fields)
        with connect(self.db) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT status FROM cards").fetchone()[0], "ready")
            c.execute("DROP TRIGGER fail_approval")
        self.approve(fields)
        self.approve(dict(fields, text="a duplicate request must not replace approval"))
        self.assertEqual(self.row("cards")["draft"], fields["text"])
        for sql in ("UPDATE outbox SET payload='{}'", "UPDATE cards SET draft='changed'", "UPDATE cards SET status='ready'"):
            with self.assertRaises(sqlite3.IntegrityError), connect(self.db) as c:
                c.execute(sql)

    def test_interrupted_api_response_isolated_and_recoverable(self):
        for i, error in enumerate((http.client.IncompleteRead(b'private response', 100), http.client.RemoteDisconnected('private response'), ConnectionResetError('private response'), ssl.SSLError('private response'))):
            with self.subTest(error=type(error).__name__):
                failed, later = f"failed-{i}", f"later-{i}"
                with connect(self.db) as c:
                    c.execute("UPDATE settings SET end=?", (time.time()+300,))
                    for name in (failed, later):
                        c.execute("INSERT INTO jobs VALUES(?,?,'draft','')", (name, EVIDENCE))
                        c.execute("INSERT INTO cards VALUES(?,?,'decision',1,NULL,NULL,NULL,'drafting')", (name, name))
                result = {"output": [{"content": [{"type": "output_text", "text": json.dumps({"cards": [dict(kind="decision", text="검증된 결정", n=1, quote=QUOTE)]})}]}]}
                broken, success = MagicMock(), MagicMock()
                for response in (broken, success):
                    response.__enter__.return_value = response
                broken.read.side_effect = error
                success.read.return_value = json.dumps(result).encode()
                with patch.dict(os.environ, OPENAI_API_KEY="fixture-only"), patch("urllib.request.urlopen", side_effect=[broken, success]) as api:
                    collector.process(self.db, gate=work_gate())
                self.assertEqual(api.call_count, 2)
                self.assertEqual(self.row("jobs", failed)["state"], "failed_draft")
                self.assertEqual(self.row("jobs", failed)["detail"], type(error).__name__)
                self.assertEqual(self.row("jobs", failed)["evidence"], EVIDENCE)
                self.assertEqual(self.row("cards", failed)["status"], "manual")
                self.assertEqual(self.row("cards", later)["status"], "ready")
                with server(Review, self.db) as srv:
                    self.assertEqual(post(srv, "/retry", dict(id=failed))[0], 303)
                with patch.object(collector, "call_api", return_value=result):
                    collector.process(self.db, gate=work_gate())
                self.assertEqual(self.row("cards", failed)["status"], "ready")

    def test_lost_ack_restart_and_network_without_db_lock(self):
        self.approve(self.card())
        def write_while_network_pending():
            with connect(self.db) as c:
                c.execute("PRAGMA busy_timeout=100")
                c.execute("UPDATE settings SET paused=1")
        self.api.before_reply = write_while_network_pending
        self.api.lose_reply = True
        self.deliver()
        self.assertEqual(self.row("cards")["status"], "queued")
        self.assertEqual(self.row("outbox")["state"], "pending")
        frozen = self.row("outbox")["payload"]
        initialize(self.db)
        self.due()
        self.api.lose_reply = False
        self.deliver()
        self.assertEqual(self.row("settings", 1)["paused"], 1)
        self.assertEqual(self.row("outbox")["payload"], frozen)
        self.assertEqual(self.row("cards")["status"], "shared")
        # The fake answers 409 to a retry that changes the stored envelope, so 'shared' means the frozen one was resent.
        self.assertEqual(list(self.api.records), ["c"])
        self.assertEqual(self.api.records["c"]["packet"], json.loads(frozen))

    def test_retry_budget_http_errors_and_manual_retry(self):
        self.approve(self.card())
        review = self.review()
        retry = dict(id="c", teamId=FAKE_TEAM)
        for failure, expected in ((401,"blocked"), (403,"blocked"), (400,"blocked"), (409,"blocked"), (302,"blocked"), (429,"pending")):
            self.api.failure = failure
            self.deliver()
            self.assertEqual(self.row("outbox")["state"], expected)
            if expected == "blocked":
                self.assertEqual(post(review, "/retry-delivery", retry)[0], 303)
            self.due()
        self.api.failure = 503
        while self.row("outbox")["state"] == "pending":
            self.deliver()
            self.due()
        self.assertEqual(self.row("outbox")["attempts"], delivery.MAX_ATTEMPTS)
        frozen = self.row("outbox")["payload"]
        self.assertFalse(self.deliver())
        self.assertEqual(post(review, "/retry-delivery", retry)[0], 303)
        self.api.failure = 0
        self.deliver()
        self.assertEqual(self.row("outbox")["payload"], frozen)
        self.assertEqual(self.row("cards")["status"], "shared")
        self.assertEqual(self.api.records["c"]["packet"], json.loads(frozen))

    def test_bad_ack_and_backoff(self):
        self.approve(self.card())
        self.api.bad_reply = True
        self.deliver()
        self.assertEqual(self.row("outbox")["state"], "pending")
        self.assertGreater(self.row("outbox")["next_attempt"], time.time())
        self.assertFalse(self.deliver())
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET attempts=?,next_attempt=0", (delivery.MAX_ATTEMPTS,))
        self.deliver()
        self.assertEqual(self.row("outbox")["state"], "blocked")

    def test_http_concurrent_approval_manual_recovery_and_boundaries(self):
        fields = dict(self.card(manual=True), target_team=FAKE_TEAM)
        with server(Review, self.db) as unconnected:
            self.assertEqual(post(unconnected, "/approve", fields)[0], 400)
        self.assertEqual(self.row("cards")["status"], "manual")
        srv = self.review()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: post(srv, "/approve", fields)[0], range(6)))
        self.assertEqual(results, [303]*6)
        self.assertEqual(self.row("jobs")["state"], "done")
        self.assertEqual(post(srv, "/retry", dict(id="c", teamId=FAKE_TEAM))[0], 400)
        self.assertEqual(self.row("cards")["status"], "queued")
        markup = get_page(srv)[1]
        self.assertIn("승인 저장됨", markup)
        self.assertNotIn('action="/approve"', markup)
        with connect(self.db) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM outbox").fetchone()[0], 1)
        with patch.object(collector, "call_api", side_effect=AssertionError("empty draft must not call AI")):
            collector.draft(self.db, self.row("jobs"), work_gate())

    def test_approval_without_destination_is_never_sent(self):
        """An approval with no recorded destination (made in the former local demo mode) stays in the folder: the
        delivery worker blocks it and the retry form cannot requeue it."""
        self.card()
        packet = dict(id="c", label="결정", text="original draft", quote=QUOTE, speaker="사용자")
        with connect(self.db) as c:
            c.execute("UPDATE cards SET status='queued' WHERE id='c'")
            c.execute("INSERT INTO outbox(id,payload,state,created) VALUES('c',?,'pending',?)",
                      (json.dumps(packet, ensure_ascii=False), time.time()))
        self.assertTrue(self.deliver())
        self.assertEqual(self.row("outbox")["state"], "blocked")
        self.assertEqual(post(self.review(), "/retry-delivery", dict(id="c", teamId=FAKE_TEAM))[0], 400)
        self.assertEqual(self.row("outbox")["state"], "blocked")
        self.assertFalse(self.deliver())
        self.assertEqual(self.api.records, {})

    def test_ended_session_refuses_the_legacy_api_call(self):
        """collector.call_api checks the collection window before the key or any network access."""
        with (patch.dict(os.environ, OPENAI_API_KEY="fixture-only"),
              patch("urllib.request.urlopen", side_effect=AssertionError("unexpected network access")) as api):
            with self.assertRaisesRegex(ValueError, "수집 시간이 종료"):
                collector.call_api(self.db, "decisions", {})
        self.assertEqual(api.call_count, 0)

    def test_batch_draft_rollback(self):
        self.card()
        with connect(self.db) as c:
            c.execute("UPDATE cards SET status='drafting',draft=NULL,quote=NULL,role=NULL")
            c.execute("INSERT INTO cards VALUES('task','c','task',0,NULL,NULL,NULL,'drafting')")
            c.execute("UPDATE jobs SET state='draft'")
        drafts = [dict(kind="decision",text="ok",n=1,quote=QUOTE), dict(kind="task",text="bad",n=999,quote="missing")]
        response = dict(output=[dict(content=[dict(type="output_text",text=json.dumps(dict(cards=drafts)))])])
        with patch.object(collector, "call_api", return_value=response), self.assertRaises(ValueError):
            collector.draft(self.db, self.row("jobs"), work_gate())
        with connect(self.db) as c:
            self.assertTrue(all(r[0] is None and r[1] == "drafting" for r in c.execute("SELECT draft,status FROM cards")))

    def test_constraints_and_closed_connection(self):
        self.card()
        for sql in ("UPDATE cards SET kind='unknown'", "UPDATE cards SET job='missing'", "UPDATE jobs SET state='bogus'",
                    "UPDATE cards SET role=NULL", "UPDATE settings SET paused=2", "UPDATE jobs SET evidence='null'"):
            with self.assertRaises(sqlite3.IntegrityError), connect(self.db) as c:
                c.execute(sql)
        with connect(self.db) as c:
            self.assertEqual(c.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            c.execute("SELECT 1")

    def test_legacy_migration_and_failure_rollback(self):
        for invalid in (False, True):
            db = self.root / ("invalid.sqlite" if invalid else "legacy.sqlite")
            with connect(db) as c:
                c.executescript(LEGACY)
                c.execute("INSERT INTO jobs VALUES('j',?,'done','')", (EVIDENCE,))
                c.execute("INSERT INTO cards VALUES('c',?,'task',0,NULL,NULL,NULL,'manual')", ("missing" if invalid else "j",))
            if invalid:
                with self.assertRaises(sqlite3.IntegrityError):
                    initialize(db)
            else:
                initialize(db)
                initialize(db)
            with connect(db) as c:
                self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 0 if invalid else 2)
                self.assertEqual(c.execute("SELECT count(*) FROM cards").fetchone()[0], 1)
                if invalid:
                    self.assertFalse(c.execute("SELECT name FROM sqlite_master WHERE name='outbox'").fetchall())
            backups = list(self.root.glob(db.name + ".v0-*.bak.sqlite"))
            self.assertEqual(len(backups), 1)
            if os.name != "nt":
                self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            with connect(backups[0]) as c:
                self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 0)
                self.assertEqual(c.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_runtime_lock(self):
        path = self.root / "run.lock"
        with runtime_lock(path), self.assertRaises(SystemExit):
            with runtime_lock(path):
                self.fail("second owner acquired lock")
        with runtime_lock(path):
            pass

    def test_cli_without_team_server_refuses_before_starting(self):
        state = self.root / "new-state"
        result = subprocess.run([sys.executable, str(APP), "run", "--project", str(self.root), "--state", str(state)],
                                env=child_environment(), capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("팀 서버 연결이 필요합니다", result.stderr)
        self.assertIn("팀_서버_사용법.md", result.stderr)
        self.assertFalse(state.exists())

    def test_cli_restart_and_single_owner(self):
        fields = self.card()
        self.approve(fields)
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET next_attempt=?", (time.time() + 60,))
        def launch():
            return subprocess.Popen([sys.executable, str(APP), "run", "--project", str(self.root),
                "--state", str(self.root), "--port", "0",
                "--team-api", self.api.url, "--team-token-file", str(self.api.key_file),
                "--codex-dir", str(self.root / "absent-codex"), "--claude-dir", str(self.root / "absent-claude")],
                env=child_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        def ready(child):
            line = first_line(child)
            if line is None:
                self.fail("CLI startup timed out")
            if not line:
                self.fail("CLI exited: " + child.communicate(timeout=3)[1])
            self.assertIn("검토함 http://", line)
        child = launch()
        try:
            ready(child)
            second = launch()
            _, error = second.communicate(timeout=5)
            self.assertNotEqual(second.returncode, 0)
            self.assertIn("이미 실행 중", error)
            self.assertEqual(self.row("cards")["status"], "queued")
            # A killed process must not leave the state folder locked: the next start below has to succeed.
            child.kill()
            child.communicate(timeout=5)
            self.due()
            child = launch()
            ready(child)
            wait_until(lambda: self.row("cards")["status"] == "shared")
            self.assertEqual(self.row("cards")["status"], "shared")
            child.terminate()
            child.communicate(timeout=5)
            child = launch()
            ready(child)
        finally:
            child.terminate()
            child.communicate(timeout=5)
        self.assertEqual(list(self.api.records), ["c"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
