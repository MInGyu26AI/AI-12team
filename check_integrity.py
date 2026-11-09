"""Offline regression tests: isolated SQLite, loopback HTTP and child processes."""
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import socket
import ssl
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

import collector
import delivery
from demo_board import Board
from local_fixtures import first_line, free_ports, get_page, post, public_card, server, wait_until, work_gate
from review_page import Review
from runtime import child_environment
from storage import connect, initialize, runtime_lock

APP = Path(__file__).with_name("app.py")

QUOTE = "DB는 Supabase로 확정했어."
EVIDENCE = json.dumps([dict(n=1, role="user", text=QUOTE)], ensure_ascii=False)
LEGACY = """
CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),project TEXT,start REAL,end REAL,paused INTEGER,status TEXT);
CREATE TABLE cursors(chat TEXT PRIMARY KEY,pos INTEGER);
CREATE TABLE pauses(start REAL PRIMARY KEY,end REAL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,evidence TEXT,state TEXT,detail TEXT);
CREATE TABLE cards(id TEXT PRIMARY KEY,job TEXT,kind TEXT,adopted INTEGER,draft TEXT,quote TEXT,role TEXT,status TEXT);
"""


class FaultBoard(Board):
    def do_POST(self):
        if getattr(self.server, "failure", 0):
            return self.reply(self.server.failure, "synthetic error")
        super().do_POST()

    def reply(self, status, value, mime="text/html; charset=utf-8"):
        if status == 200 and self.command == "POST":
            callback = getattr(self.server, "before_reply", None)
            if callback:
                callback()
            if getattr(self.server, "lose_reply", False):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if getattr(self.server, "bad_reply", False):
                value = '{"id":"wrong-card"}'
        super().reply(status, value, mime)


class IntegrityFixture(unittest.TestCase):
    """Private and board databases with an ended session; cards are added per test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.db, self.board = self.root / "private.sqlite", self.root / "board.sqlite"
        initialize(self.db)
        initialize(self.board, board=True)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (str(self.root), time.time()-20, time.time()-10))

    def card(self, name="c", manual=False):
        with connect(self.db) as c:
            c.execute("INSERT INTO jobs VALUES(?,?,?,'')", (name, EVIDENCE, "failed_draft" if manual else "done"))
            c.execute("INSERT INTO cards VALUES(?,?,'decision',1,?,?,?,?)",
                      (name, name, None if manual else "original draft", None if manual else QUOTE,
                       None if manual else "user", "manual" if manual else "ready"))
        return dict(id=name, text="승인한 최종 문구", quote=QUOTE, source="1")

    def approve(self, fields):
        with connect(self.db) as c:
            c.execute("BEGIN IMMEDIATE")
            delivery.approve(c, fields.__getitem__)

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
        with server(FaultBoard, self.board) as srv:
            def write_while_network_pending():
                with connect(self.db) as c:
                    c.execute("PRAGMA busy_timeout=100")
                    c.execute("UPDATE settings SET paused=1")
            srv.before_reply = write_while_network_pending
            srv.lose_reply = True
            delivery.deliver(self.db, srv.board_url, srv.secret)
            self.assertEqual(self.row("cards")["status"], "queued")
            self.assertEqual(self.row("outbox")["state"], "pending")
            frozen = self.row("outbox")["payload"]
            initialize(self.db)
            self.due()
            srv.lose_reply = False
            delivery.deliver(self.db, srv.board_url, srv.secret)
            self.assertEqual(self.row("outbox")["payload"], frozen)
            self.assertEqual(self.row("cards")["status"], "shared")
            with connect(self.board) as c:
                self.assertEqual(c.execute("SELECT count(*) FROM records").fetchone()[0], 1)
                self.assertEqual(c.execute("SELECT text FROM records").fetchone()[0], json.loads(frozen)["text"])
            changed = dict(json.loads(frozen), text="changed retry")
            self.assertEqual(post(srv, "/items/approve", changed, True)[0], 409)

    def test_retry_budget_http_errors_and_manual_retry(self):
        self.approve(self.card())
        with server(FaultBoard, self.board) as srv, server(Review, self.db) as review:
            for failure, expected in ((401,"blocked"), (403,"blocked"), (400,"blocked"), (409,"blocked"), (302,"blocked"), (429,"pending")):
                srv.failure = failure
                delivery.deliver(self.db, srv.board_url, srv.secret)
                self.assertEqual(self.row("outbox")["state"], expected)
                if expected == "blocked":
                    self.assertEqual(post(review, "/retry-delivery", dict(id="c"))[0], 303)
                self.due()
            srv.failure = 503
            while self.row("outbox")["state"] == "pending":
                delivery.deliver(self.db, srv.board_url, srv.secret)
                self.due()
            self.assertEqual(self.row("outbox")["attempts"], delivery.MAX_ATTEMPTS)
            frozen = self.row("outbox")["payload"]
            self.assertFalse(delivery.deliver(self.db, srv.board_url, srv.secret))
            self.assertEqual(post(review, "/retry-delivery", dict(id="c"))[0], 303)
            srv.failure = 0
            delivery.deliver(self.db, srv.board_url, srv.secret)
            self.assertEqual(self.row("outbox")["payload"], frozen)
            self.assertEqual(self.row("cards")["status"], "shared")

    def test_bad_ack_and_backoff(self):
        self.approve(self.card())
        with server(FaultBoard, self.board) as srv:
            srv.bad_reply = True
            delivery.deliver(self.db, srv.board_url, srv.secret)
            self.assertEqual(self.row("outbox")["state"], "pending")
            self.assertGreater(self.row("outbox")["next_attempt"], time.time())
            self.assertFalse(delivery.deliver(self.db, srv.board_url, srv.secret))
            with connect(self.db) as c:
                c.execute("UPDATE outbox SET attempts=?,next_attempt=0", (delivery.MAX_ATTEMPTS,))
            delivery.deliver(self.db, srv.board_url, srv.secret)
            self.assertEqual(self.row("outbox")["state"], "blocked")

    def test_http_concurrent_approval_manual_recovery_and_boundaries(self):
        fields = self.card(manual=True)
        with server(Review, self.db) as srv:
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda _: post(srv, "/approve", fields)[0], range(6)))
            self.assertEqual(results, [303]*6)
            self.assertEqual(self.row("jobs")["state"], "done")
            self.assertEqual(post(srv, "/retry", dict(id="c"))[0], 400)
            self.assertEqual(self.row("cards")["status"], "queued")
            markup = get_page(srv)[1]
            self.assertIn("승인 저장됨", markup)
            self.assertNotIn('action="/approve"', markup)
        with connect(self.db) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM outbox").fetchone()[0], 1)
        with patch.object(collector, "call_api", side_effect=AssertionError("empty draft must not call AI")):
            collector.draft(self.db, self.row("jobs"), work_gate())
        with server(Board, self.board) as srv:
            for payload in (None, [], {}, dict(id="x",label="unknown",text="x",quote="x",speaker="AI")):
                self.assertEqual(post(srv, "/items/approve", payload, True)[0], 400)

    def test_demo_board_refuses_team_packets(self):
        packet = dict(id="x", label="결정", text="DB = SQLite", quote="SQLite로 결정했다.", speaker="사용자", version=2, card=public_card())
        with server(Board, self.board) as srv:
            self.assertEqual(post(srv, "/items/approve", packet, True)[0], 400)
        with connect(self.board) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM records").fetchone()[0], 0)

    def test_demo_board_checks_host_and_path_before_the_secret(self):
        with server(Board, self.board) as srv:
            connection = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
            try:
                connection.putrequest("POST", "/elsewhere")
                connection.putheader("Authorization", b"Bearer \xe9")
                connection.putheader("Content-Length", "0")
                connection.endheaders()
                self.assertEqual(connection.getresponse().status, 403)
            finally:
                connection.close()

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

    def test_cli_restart_and_single_owner(self):
        fields = self.card()
        self.approve(fields)
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET next_attempt=?", (time.time() + 60,))
        def launch():
            review_port, board_port = free_ports(2)
            return subprocess.Popen([sys.executable, str(APP), "run", "--project", str(self.root),
                "--state", str(self.root), "--port", str(review_port), "--board-port", str(board_port),
                "--codex-dir", str(self.root / "absent-codex"), "--claude-dir", str(self.root / "absent-claude")],
                env=child_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        def ready(child):
            line = first_line(child)
            if line is None:
                self.fail("CLI startup timed out")
            if not line:
                self.fail("CLI exited: " + child.communicate(timeout=3)[1])
            self.assertIn("검토함 http://", line)
        def board_released():
            try:
                with runtime_lock(self.root / "board.lock"):
                    return True
            except SystemExit:
                return False
        child = launch()
        try:
            ready(child)
            second = launch()
            _, error = second.communicate(timeout=5)
            self.assertNotEqual(second.returncode, 0)
            self.assertIn("이미 실행 중", error)
            self.assertEqual(self.row("cards")["status"], "queued")
            child.kill()
            child.communicate(timeout=5)
            self.assertTrue(wait_until(board_released), "orphan board did not release state")
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
        with connect(self.board) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM records").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
