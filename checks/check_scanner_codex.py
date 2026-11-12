"""Rust scanner checks for Codex logs, using synthetic rollout logs and SQLite index files."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import hashlib
import json
import sqlite3
import subprocess
import tempfile
import time
import unittest
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import scanner_runner
import standalone_classifier
from local_fixtures import work_gate
from runtime import child_environment, collector_binary
from storage import connect, initialize

SUBAGENT_SOURCES = ({"subagent": {"thread_spawn": {"parent_thread_id": "parent"}}}, {"subagent": {"other": "guardian"}})
PROMPT = "DB는 Supabase로 확정했어. 이메일 demo@example.com"
COLLECTION_STOPPED = ("UPDATE settings SET paused=1", "UPDATE settings SET paused=0,end=start")
# scanner/src/excerpt.rs limits
MAX_EXCERPTS = 24
MAX_EXCERPT_CHARS = 600


def job_id(key):
    return hashlib.sha256(key.encode()).hexdigest()


def run_scanner(*args):
    """Runs the built scanner directly, past the check in scanner_runner.scan() that collection is running."""
    return subprocess.run([str(collector_binary()), *map(str, args)], env=child_environment(), capture_output=True)


@contextmanager
def write_lock(db):
    """Holds the database's write lock, as another process in the middle of a write would; reads still work."""
    with closing(sqlite3.connect(db, isolation_level=None)) as lock:
        lock.execute("BEGIN IMMEDIATE")
        yield


def split_last_line(text):
    """Splits `text` inside its last line, as when a log is read while that line is being written."""
    cut = text.rstrip("\n").rfind("\n") + 10
    return text[:cut], text[cut:]


def decision_answers(probability):
    """A classification answer: a decision adopted with `probability`, every other question unlikely."""
    return {"answers": [{"type": "predicate", "name": k, "probability": probability if k in ("decision", "adopted") else 0.01}
                        for k in standalone_classifier.QUESTIONS]}


def fake_api(_db, endpoint, _body):
    """Mock OpenAI: every turn is an adopted decision, drafted as the Supabase card."""
    if endpoint == "decisions":
        return decision_answers(0.95)
    card = {"kind": "decision", "text": "DB로 Supabase를 사용한다.", "n": 1, "quote": "DB는 Supabase로 확정했어."}
    return {"output": [{"content": [{"type": "output_text", "text": json.dumps({"cards": [card]}, ensure_ascii=False)}]}]}


class CodexScannerChecks(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.start = time.time() - 60
        self.project = str(self.root / "project")
        self.codex = self.root / "codex"
        self.sessions = self.codex / "sessions"
        self.sessions.mkdir(parents=True)
        db = self.db = self.root / "private.sqlite"
        initialize(db)
        self.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (self.project, self.start, self.start + 600))
        with connect(self.codex / "state_5.sqlite") as c:
            c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,created_at_ms INTEGER,cwd TEXT,archived INTEGER,"
                      "source TEXT DEFAULT 'cli')")

    def execute(self, statement, params=()):
        with connect(self.db) as c:
            return c.execute(statement, params).fetchall()

    def event(self, kind, payload, offset):
        at = datetime.fromtimestamp(self.start + offset, timezone.utc).isoformat()
        return json.dumps({"type": kind, "timestamp": at, "payload": payload}, ensure_ascii=False) + "\n"

    def add_chat(self, chat, cwd=None, created=1, location=None, source="cli", meta_source="cli"):
        """Writes a rollout log holding only its session metadata and lists it in the index."""
        cwd = cwd or self.project
        file = location or self.sessions / (chat + ".jsonl")
        file.write_text(self.event("session_meta", {"id": chat, "cwd": cwd, "source": meta_source}, 10), encoding="utf-8")
        with connect(self.codex / "state_5.sqlite") as c:
            c.execute("INSERT INTO threads VALUES(?,?,?,?,0,?)",
                      (chat, str(file), int((self.start + created) * 1000), cwd, json.dumps(source)))
        return file

    def turn(self, turn_id, cwd=None, aborted=False, began=10, ended=11, prompt=PROMPT):
        """One turn: a user prompt (by default with a secret), records that are not evidence, and the final answer."""
        def message(role, kind, text, **extra):
            return {"type": "message", "role": role, "content": [{"type": kind, "text": text}], **extra}
        return "".join([
            self.event("event_msg", {"type": "task_started", "turn_id": turn_id}, began),
            self.event("turn_context", {"cwd": cwd or self.project}, began),
            self.event("response_item", message("user", "input_text", prompt), began),
            self.event("response_item", message("assistant", "output_text", "SHOULD_NOT_COLLECT", phase="commentary"), began),
            self.event("response_item", {"type": "function_call_output", "output": "TOOL_SECRET"}, began),
            self.event("response_item", message("user", "input_text", "<environment_context>IGNORE_META"), began),
            self.event("response_item", message("assistant", "output_text", "연결 작업을 정리했습니다.", phase="final_answer"), ended),
            self.event("event_msg", {"type": "turn_aborted" if aborted else "task_complete", "turn_id": turn_id}, ended),
        ])

    def append(self, file, text):
        with file.open("a", encoding="utf-8") as f:
            f.write(text)

    def scan(self):
        scanner_runner.scan(self.db, self.codex)

    def jobs(self):
        return [dict(r) for r in self.execute("SELECT * FROM jobs ORDER BY rowid")]

    def job_ids(self):
        return {job["id"] for job in self.jobs()}

    def test_complete_turn_becomes_one_masked_job(self):
        self.append(self.add_chat("valid"), self.turn("first"))
        self.scan()
        [job] = self.jobs()
        self.assertEqual((job["id"], job["state"], job["detail"]), (job_id("valid/first"), "new", ""))
        evidence = json.loads(job["evidence"])
        self.assertEqual([(e["n"], e["role"]) for e in evidence], [(1, "user"), (2, "user"), (3, "assistant")])
        self.assertEqual(evidence[0]["text"], "DB는 Supabase로 확정했어.")
        self.assertIn("[가림]", evidence[1]["text"])
        for excerpt in evidence:
            self.assertEqual(set(excerpt), {"n", "role", "text", "conversationId", "turnId", "at"})
            self.assertEqual((excerpt["conversationId"], excerpt["turnId"]), ("valid", job["id"]))
            self.assertAlmostEqual(excerpt["at"], self.start + 11, places=2)
        for hidden in ("demo@example.com", "TOOL_SECRET", "SHOULD_NOT_COLLECT", "IGNORE_META"):
            self.assertNotIn(hidden, job["evidence"])

    def test_rescans_and_partly_written_turns_collect_each_turn_once(self):
        valid = self.add_chat("valid")
        self.append(valid, self.turn("first"))
        self.scan()
        self.scan()
        self.assertEqual(self.job_ids(), {job_id("valid/first")}, "restart duplicate")
        written, rest = split_last_line(self.turn("second"))
        self.append(valid, written)
        self.scan()
        self.assertEqual(len(self.jobs()), 1, "incomplete turn collected")
        self.append(valid, rest)
        self.scan()
        self.assertEqual(self.job_ids(), {job_id("valid/first"), job_id("valid/second")})

    def test_subagent_threads_excluded_by_index_or_session_source(self):
        self.append(self.add_chat("main"), self.turn("x"))
        for i, source in enumerate(SUBAGENT_SOURCES):
            self.append(self.add_chat(f"child-index-{i}", source=source), self.turn("x"))
            self.append(self.add_chat(f"child-meta-{i}", meta_source=source), self.turn("x"))
        self.scan()
        self.assertEqual(self.job_ids(), {job_id("main/x")}, "Codex subagent instructions collected as human evidence")

    def test_threads_and_turns_outside_project_window_or_sessions_folder_excluded(self):
        self.append(self.add_chat("main"), self.turn("x"))
        self.append(self.add_chat("wrong-project", cwd="/other"), self.turn("x", cwd="/other"))
        self.append(self.add_chat("old", created=-10), self.turn("x"))
        self.append(self.add_chat("outside", location=self.root / "outside.jsonl"), self.turn("x"))
        self.append(self.add_chat("wrong-context"), self.turn("x", cwd="/other"))
        self.append(self.add_chat("aborted"), self.turn("x", aborted=True))
        self.scan()
        self.assertEqual(self.job_ids(), {job_id("main/x")})

    def test_turn_overlapping_pause_excluded(self):
        valid = self.add_chat("valid")
        self.append(valid, self.turn("before-pause"))
        self.execute("INSERT INTO pauses VALUES(?,?)", (self.start + 20, self.start + 30))
        self.append(valid, self.turn("paused", began=19, ended=21))
        self.scan()
        self.assertEqual(self.job_ids(), {job_id("valid/before-pause")})

    def test_paused_or_expired_collection_waits_until_resumed(self):
        valid = self.add_chat("valid")
        self.append(valid, self.turn("first"))
        self.scan()
        self.append(valid, self.turn("second", began=40, ended=41))
        for stopped in COLLECTION_STOPPED:
            self.execute(stopped)
            self.scan()
            self.assertEqual(self.job_ids(), {job_id("valid/first")}, stopped)
        self.execute("UPDATE settings SET end=?", (self.start + 600,))
        self.scan()
        self.assertEqual(self.job_ids(), {job_id("valid/first"), job_id("valid/second")})

    def test_scanner_itself_collects_nothing_while_paused_or_expired(self):
        self.append(self.add_chat("valid"), self.turn("first"))
        for stopped in COLLECTION_STOPPED:
            self.execute(stopped)
            self.assertEqual(run_scanner(self.db, self.codex).returncode, 0, stopped)
            self.assertEqual(self.jobs(), [], stopped)
        self.execute("UPDATE settings SET end=?", (self.start + 600,))
        self.assertEqual(run_scanner(self.db, self.codex).returncode, 0)
        self.assertEqual(self.job_ids(), {job_id("valid/first")})

    def test_long_turn_is_cut_to_the_excerpt_limits(self):
        long_sentence = "가" * (MAX_EXCERPT_CHARS + 100) + "."
        prompt = " ".join([long_sentence] + [f"문장 {i}." for i in range(MAX_EXCERPTS + 5)])
        self.append(self.add_chat("long"), self.turn("x", prompt=prompt))
        self.scan()
        [job] = self.jobs()
        evidence = json.loads(job["evidence"])
        self.assertEqual([e["n"] for e in evidence], list(range(1, MAX_EXCERPTS + 1)))
        self.assertEqual(evidence[0]["text"], "가" * MAX_EXCERPT_CHARS)
        self.assertEqual({e["role"] for e in evidence}, {"user"}, "the final answer did not fit")

    def test_broken_line_is_reported_and_later_threads_still_scanned(self):
        # The broken thread is listed first, so stopping at its error would leave the valid thread unread.
        broken = self.add_chat("broken")
        self.append(broken, self.turn("before") + "{not json\n" + self.turn("after"))
        self.append(self.add_chat("valid"), self.turn("first"))
        with self.assertRaises(ValueError):
            self.scan()
        self.assertEqual(self.job_ids(), {job_id("broken/before"), job_id("valid/first")})
        with self.assertRaises(ValueError, msg="the broken line was skipped instead of reported again"):
            self.scan()
        self.assertEqual(len(self.jobs()), 2)

    def test_shrunk_log_is_reported_and_later_threads_still_scanned(self):
        shrunk = self.add_chat("shrunk")
        self.append(shrunk, self.turn("first"))
        self.scan()
        shrunk.write_text(shrunk.read_text(encoding="utf-8").splitlines(keepends=True)[0], encoding="utf-8")
        self.append(self.add_chat("valid"), self.turn("first"))
        with self.assertRaises(ValueError):
            self.scan()
        self.assertEqual(self.job_ids(), {job_id("shrunk/first"), job_id("valid/first")})

    def test_locked_database_ends_the_scan_within_its_time_limit(self):
        # Every thread has a turn to store, so waiting out the lock once per thread would pass scanner_runner.scan's limit.
        chats = [f"chat-{i}" for i in range(4)]
        for chat in chats:
            self.append(self.add_chat(chat), self.turn("first"))
        with write_lock(self.db), self.assertRaises(ValueError):
            self.scan()
        self.assertEqual(self.jobs(), [])
        self.scan()
        self.assertEqual(self.job_ids(), {job_id(f"{chat}/first") for chat in chats})

    def test_jobs_feed_python_classification_and_grounded_draft(self):
        self.append(self.add_chat("valid"), self.turn("first"))
        self.scan()
        [job] = self.jobs()
        with patch.object(standalone_classifier, "call_api", side_effect=fake_api):
            standalone_classifier.classify(self.db, job, work_gate())
            standalone_classifier.draft(self.db, job, work_gate())
        [card] = self.execute("SELECT * FROM cards WHERE job=?", (job["id"],))
        self.assertEqual((card["status"], card["adopted"]), ("ready", 1))
        self.assertIn(card["quote"], json.loads(job["evidence"])[0]["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
