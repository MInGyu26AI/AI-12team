"""Rust scanner checks for Claude Code transcripts, through to the local review and board."""
import json
import re
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import app
import collector
import delivery
from check_integrity import post, server
from check_local_privacy import work_gate
from check_scanner import COLLECTION_STOPPED, decision_answers, fake_api, job_id, run_scanner, split_last_line

HIDDEN = ("demo@example.com", "TOOL_SECRET", "TOOL_RESULT_SECRET", "PRIVATE_THOUGHT", "COMMENTARY_NOT_EVIDENCE")
CLAUDE_EXCERPT_FIELDS = {"n", "role", "text", "source", "session_id", "message_id", "timestamp",
                         "conversationId", "turnId", "at"}
FAIL_JOB_INSERT = "CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"


class ClaudeScannerChecks(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.project = str(self.root / "project")
        self.start = time.time() - 300
        db = self.db = self.root / "private.sqlite"
        self.claude = self.root / "claude"
        self.folder = self.claude / "projects" / re.sub("[^a-zA-Z0-9]", "-", self.project)
        self.folder.mkdir(parents=True)
        collector.initialize(db)
        self.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (self.project, self.start, self.start + 600))
        self.codex = self.root / "codex"  # absent unless a check creates it

    def execute(self, statement, params=()):
        with collector.connect(self.db) as c:
            return c.execute(statement, params).fetchall()

    def rows(self):
        return [dict(r) for r in self.execute("SELECT * FROM jobs ORDER BY rowid")]

    def job_sessions(self):
        return [json.loads(r["evidence"])[0]["session_id"] for r in self.rows()]

    def cursor(self, session):
        rows = self.execute("SELECT pos FROM cursors WHERE chat=?", ("claude-code/" + session,))
        return rows[0]["pos"] if rows else None

    def scan(self):
        collector.scan(self.db, self.codex, self.claude)

    def event(self, session, kind, ident, parent, content, at, **extra):
        message = dict(role=kind, content=content)
        if kind == "assistant":
            message.update(id="model-" + ident, stop_reason="end_turn")
        message.update(extra.pop("message", {}))
        stamp = datetime.fromtimestamp(self.start + at, timezone.utc).isoformat()
        return json.dumps(dict(type=kind, uuid=ident, parentUuid=parent, sessionId=session, cwd=self.project,
                               timestamp=stamp, message=message, **extra), ensure_ascii=False) + "\n"

    def transcript(self, session, suffix="1", begin=20, end=30, parent=None):
        """One turn: a prompt with a secret, a tool call and its result, then a final answer with private thinking."""
        prompt = "DB는 Supabase로 확정했어. 연락처 demo@example.com"
        tool_call = [dict(type="text", text="COMMENTARY_NOT_EVIDENCE"),
                     dict(type="tool_use", id="tool", input={"secret": "TOOL_SECRET"})]
        tool_result = [dict(type="tool_result", content="TOOL_RESULT_SECRET")]
        answer = [dict(type="thinking", thinking="PRIVATE_THOUGHT"), dict(type="text", text="Supabase 연결을 진행하겠습니다.")]
        stopped_for_tool = {"message": {"stop_reason": "tool_use"}}
        return "".join([
            self.event(session, "user", "u" + suffix, parent, prompt, begin),
            self.event(session, "assistant", "tool" + suffix, "u" + suffix, tool_call, begin + 1, **stopped_for_tool),
            self.event(session, "user", "result" + suffix, "tool" + suffix, tool_result, begin + 2),
            self.event(session, "assistant", "a" + suffix, "result" + suffix, answer, end),
        ])

    def path(self, session):
        return self.folder / (session + ".jsonl")

    def write(self, session, content, append=False):
        with self.path(session).open("a" if append else "w", encoding="utf-8") as f:
            f.write(content)

    def add_session(self, **turn):
        session = str(uuid.uuid4())
        self.write(session, self.transcript(session, **turn))
        return session

    def test_final_turn_becomes_one_job_with_provenance(self):
        session = self.add_session()
        self.scan()
        [job] = self.rows()
        self.assertEqual((job["id"], job["state"], job["detail"]), (job_id(f"claude-code/{session}/model-a1"), "new", ""))
        evidence = json.loads(job["evidence"])
        self.assertEqual([(e["role"], e["message_id"]) for e in evidence],
                         [("user", "u1"), ("user", "u1"), ("assistant", "a1")])
        for excerpt in evidence:
            self.assertEqual(set(excerpt), CLAUDE_EXCERPT_FIELDS)
            self.assertEqual((excerpt["source"], excerpt["session_id"], excerpt["conversationId"], excerpt["turnId"]),
                             ("claude-code", session, session, job["id"]))
            self.assertAlmostEqual(excerpt["at"], self.start + 30, places=2)
        for hidden in HIDDEN:
            self.assertNotIn(hidden, job["evidence"])
        self.assertIn("[가림]", job["evidence"])

    def test_rescans_and_partly_written_turns_collect_each_turn_once(self):
        session = self.add_session()
        self.scan()
        self.scan()
        self.assertEqual(len(self.rows()), 1)
        written, rest = split_last_line(self.transcript(session, "2", 40, 50, parent="a1"))
        self.write(session, written, True)
        self.scan()
        self.assertEqual(len(self.rows()), 1)
        self.write(session, rest, True)
        self.scan()
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual({e["message_id"] for e in json.loads(rows[1]["evidence"])}, {"u2", "a2"})

    def test_out_of_scope_transcripts_excluded(self):
        session = self.add_session()
        names = ("old or resumed", "other project", "sidechain", "unfinished", "subagent file", "symlink")
        excluded = {name: str(uuid.uuid4()) for name in names}
        old = excluded["old or resumed"]
        self.write(old, self.transcript(old, begin=-50, end=-40) + self.transcript(old, "new", 60, 70, parent="a1"))
        other = excluded["other project"]
        self.write(other, self.transcript(other).replace(json.dumps(self.project, ensure_ascii=False), json.dumps("/other")))
        side = excluded["sidechain"]
        self.write(side, self.transcript(side).replace('"cwd":', '"isSidechain": true, "cwd":'))
        unfinished = excluded["unfinished"]
        self.write(unfinished, self.transcript(unfinished).replace('"end_turn"', 'null'))
        nested = self.folder / session / "subagents"
        nested.mkdir(parents=True)
        subagent = excluded["subagent file"]
        (nested / (subagent + ".jsonl")).write_text(self.transcript(subagent), encoding="utf-8")
        external = self.root / "outside.jsonl"
        external.write_text(self.transcript(excluded["symlink"]), encoding="utf-8")
        self.path(excluded["symlink"]).symlink_to(external)
        self.scan()
        self.assertEqual([name for name, s in excluded.items() if s in self.job_sessions()], [])
        self.assertEqual(self.job_sessions(), [session])

    def test_split_final_response_grouped_into_one_job(self):
        split = str(uuid.uuid4())
        same_response = {"message": {"id": "same-response"}}
        first, second = [dict(type="text", text="첫 번째 답변.")], [dict(type="text", text="두 번째 답변.")]
        self.write(split, self.event(split, "user", "split-u", None, "새 구현은 파랑으로 정했어.", 35)
                   + self.event(split, "assistant", "split-a1", "split-u", first, 36, **same_response)
                   + self.event(split, "assistant", "split-a2", "split-a1", second, 37, **same_response))
        self.scan()
        [job] = self.rows()
        self.assertEqual([e["message_id"] for e in json.loads(job["evidence"])], ["split-u", "split-a1", "split-a2"])

    def test_compaction_summary_excluded_and_later_prompt_accepted(self):
        compact = str(uuid.uuid4())
        reply, answer = [dict(type="text", text="SUMMARY_REPLY")], [dict(type="text", text="현재 결정을 정리했습니다.")]
        self.write(compact, self.event(compact, "user", "summary", None, "SUMMARY_NOT_HUMAN", 36, isCompactSummary=True)
                   + self.event(compact, "assistant", "summary-a", "summary", reply, 37)
                   + self.event(compact, "user", "fresh-u", "summary-a", "현재 결정만 기록해.", 38)
                   + self.event(compact, "assistant", "fresh-a", "fresh-u", answer, 39))
        self.scan()
        [job] = self.rows()
        self.assertEqual([e["message_id"] for e in json.loads(job["evidence"])], ["fresh-u", "fresh-a"])
        self.assertNotIn("SUMMARY_", job["evidence"])

    def test_turns_overlapping_or_starting_in_a_pause_excluded(self):
        session = self.add_session()
        self.execute("INSERT INTO pauses VALUES(?,?)", (self.start + 85, self.start + 90))
        self.add_session(begin=80, end=95)
        born_paused = str(uuid.uuid4())
        self.write(born_paused, self.transcript(born_paused, begin=86, end=95)
                   + self.transcript(born_paused, "later", 100, 110, parent="a1"))
        self.scan()
        self.assertEqual(self.job_sessions(), [session])

    def test_paused_or_expired_collection_waits_until_resumed(self):
        session = self.add_session()
        self.scan()
        self.write(session, self.transcript(session, "2", 120, 130, parent="a1"), True)
        for stopped in COLLECTION_STOPPED:
            self.execute(stopped)
            self.scan()
            self.assertEqual(len(self.rows()), 1, stopped)
        self.execute("UPDATE settings SET end=?", (self.start + 600,))
        self.scan()
        self.assertEqual({e["message_id"] for e in json.loads(self.rows()[1]["evidence"])}, {"u2", "a2"})

    def test_scanner_itself_collects_nothing_while_paused_or_expired(self):
        session = self.add_session()
        for stopped in COLLECTION_STOPPED:
            self.execute(stopped)
            self.assertEqual(run_scanner(self.db, self.codex, self.claude).returncode, 0, stopped)
            self.assertEqual(self.rows(), [], stopped)
        self.execute("UPDATE settings SET end=?", (self.start + 600,))
        self.assertEqual(run_scanner(self.db, self.codex, self.claude).returncode, 0)
        self.assertEqual(self.job_sessions(), [session])

    def test_failed_job_insert_keeps_cursor_and_retry_imports_once(self):
        session = self.add_session()
        self.scan()
        before = self.cursor(session)
        self.execute(FAIL_JOB_INSERT)
        self.write(session, self.transcript(session, "2", 40, 50, parent="a1"), True)
        with self.assertRaises(ValueError, msg="scanner hid failed write"):
            self.scan()
        self.assertEqual(self.cursor(session), before)
        self.execute("DROP TRIGGER fail_job")
        self.scan()
        self.scan()
        self.assertEqual(len(self.rows()), 2)

    def test_broken_transcript_is_reported_and_other_transcripts_still_scanned(self):
        broken = str(uuid.uuid4())
        self.write(broken, "{not json\n" + self.transcript(broken))
        session = self.add_session()
        with self.assertRaises(ValueError):
            self.scan()
        self.assertEqual(self.job_sessions(), [session])
        self.assertIsNone(self.cursor(broken))

    def test_codex_failure_does_not_block_claude_input_or_processing(self):
        db, missing_codex, claude = self.db, self.codex, self.claude
        missing_codex.mkdir()
        with collector.connect(missing_codex / "state_5.sqlite") as c:
            c.execute("CREATE TABLE unexpected(x)")
        session = self.add_session()
        with self.assertRaises(ValueError, msg="broken Codex source was not reported"):
            self.scan()
        self.assertEqual(self.job_sessions(), [session])
        with (patch.object(app,"scan",side_effect=ValueError("source unavailable")), patch.object(app,"process") as process,
              patch.object(app.time,"sleep",side_effect=RuntimeError("stop test loop"))):
            try:
                app.watch(db,missing_codex,claude)
            except RuntimeError:
                pass
            process.assert_called_once_with(db)

    def test_claude_job_reaches_board_through_review_approval(self):
        db = self.db
        self.add_session()
        self.scan()
        [job] = self.rows()
        with patch.object(collector, "call_api", side_effect=fake_api):
            collector.classify(db, job, work_gate())
            collector.draft(db, job, work_gate())
        board = self.root / "board.sqlite"
        collector.initialize(board,board=True)
        with server(app.Review,db) as review, server(app.Board,board) as board_server:
            approval = dict(id=job["id"] + "-decision", text="Supabase를 사용한다.", quote="DB는 Supabase로 확정했어.")
            self.assertEqual(post(review, "/approve", approval)[0], 303)
            delivery.deliver(db, board_server.board_url, board_server.secret)
        with collector.connect(board) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM records").fetchone()[0], 1)

    def test_codex_and_claude_logs_of_one_session_keep_separate_cursors(self):
        session = self.add_session()
        sessions = self.codex / "sessions"
        sessions.mkdir(parents=True)
        codex_log = sessions / (session + ".jsonl")

        def codex_event(kind, payload, at):
            stamp = datetime.fromtimestamp(self.start + at, timezone.utc).isoformat()
            return json.dumps(dict(type=kind, payload=payload, timestamp=stamp)) + "\n"
        prompt = [dict(type="input_text", text="Codex에서도 연결할게.")]
        codex_log.write_text("".join([
            codex_event("session_meta", dict(id=session, cwd=self.project), 180),
            codex_event("event_msg", dict(type="task_started", turn_id="codex-turn"), 181),
            codex_event("turn_context", dict(cwd=self.project), 181),
            codex_event("response_item", dict(type="message", role="user", content=prompt), 182),
            codex_event("event_msg", dict(type="task_complete", turn_id="codex-turn"), 190),
        ]))
        with collector.connect(self.codex / "state_5.sqlite") as c:
            c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,created_at_ms INTEGER,cwd TEXT,archived INTEGER,"
                      "source TEXT)")
            c.execute("INSERT INTO threads VALUES(?,?,?,?,0,'cli')",
                      (session, str(codex_log), int((self.start + 180) * 1000), self.project))
        self.scan()
        self.scan()
        self.assertEqual({r["id"] for r in self.rows()},
                         {job_id(f"{session}/codex-turn"), job_id(f"claude-code/{session}/model-a1")})
        self.assertEqual({r["chat"] for r in self.execute("SELECT chat FROM cursors")},
                         {session, "claude-code/" + session})

    def write_block(self, session, ident, parent, role, text, at):
        """Appends one block of a conversation whose answer blocks all share the response id "one-response"."""
        extra = {"message": {"id": "one-response"}} if role == "assistant" else {}
        self.write(session, self.event(session, role, ident, parent, [dict(type="text", text=text)], at, **extra), True)

    def advance_first_job(self, job, state):
        """Moves the first job as far as `state` the way the review app would; returns the tables then."""
        card = job["id"] + "-decision"
        with collector.connect(self.db) as c:
            if state != "new":
                c.execute("UPDATE jobs SET state='done'")
                c.execute("INSERT INTO cards(id,job,kind,adopted,draft,quote,role,status) "
                          "VALUES(?,?,'decision',0,'original draft','FIRST_BLOCK','assistant','ready')", (card, job["id"]))
            if state in ("queued", "shared"):
                delivery.approve(c, dict(id=card, text="사용자가 승인한 내용", quote="FIRST_BLOCK").__getitem__)
            if state == "shared":
                c.execute("UPDATE cards SET status='shared'")
                c.execute("UPDATE outbox SET state='sent'")
            return {t: [tuple(r) for r in c.execute(f"SELECT * FROM {t}")] for t in ("jobs", "cards", "outbox")}

    def assert_supplement_keeps_first_job(self, session, first, before):
        """The late block became its own job and the first job, its cards and its outbox stayed as they were."""
        jobs = self.rows()
        self.assertEqual(len(jobs), 2, "late Claude block lost on duplicate response id")
        self.assertEqual(jobs[1]["id"], job_id(f"claude-code/{session}/one-response/continuation/a2"))
        with collector.connect(self.db) as c:
            for table in ("cards", "outbox"):
                self.assertEqual([tuple(r) for r in c.execute(f"SELECT * FROM {table}")], before[table])
            first_now = c.execute("SELECT * FROM jobs WHERE id=?", (first["id"],)).fetchone()
            self.assertEqual(tuple(first_now), before["jobs"][0])
        extra = json.loads(jobs[1]["evidence"])
        self.assertEqual([(e["n"], e["role"], e["text"], e["message_id"]) for e in extra],
                         [(1, "assistant", "LATE_BLOCK", "a2")])
        self.assertEqual(extra[0]["continuation_of"], first["id"])

    def check_late_block(self, state):
        """A block added to a stored response becomes a supplement job; `state` is how far the first job got."""
        session = str(uuid.uuid4())
        self.write_block(session, "u", None, "user", "배포 방식을 확인해줘.", 1)
        self.write_block(session, "a1", "u", "assistant", "FIRST_BLOCK", 2)
        self.scan()
        [first] = self.rows()
        before = self.advance_first_job(first, state)
        cursor = self.cursor(session)
        self.write_block(session, "a2", "a1", "assistant", "LATE_BLOCK", 3)
        self.execute(FAIL_JOB_INSERT)
        with self.assertRaises(ValueError, msg="failed late insert did not report failure"):
            self.scan()
        self.assertEqual(self.cursor(session), cursor)
        self.execute("DROP TRIGGER fail_job")
        self.scan()
        self.assert_supplement_keeps_first_job(session, first, before)
        supplement = self.rows()[1]
        # Even a mistaken model adoption score cannot turn an AI-only supplement into human approval.
        with patch.object(collector, "call_api", return_value=decision_answers(0.99)):
            collector.classify(self.db, supplement, work_gate())
        self.assertEqual(self.execute("SELECT adopted FROM cards WHERE job=?", (supplement["id"],))[0]["adopted"], 0)
        self.write_block(session, "a3", "a2", "assistant", "THIRD_BLOCK", 4)
        self.scan()
        self.scan()
        supplements = [[e["text"] for e in json.loads(job["evidence"])] for job in self.rows()[1:]]
        self.assertEqual(supplements, [["LATE_BLOCK"], ["THIRD_BLOCK"]])
        self.assertEqual(self.cursor(session), self.path(session).stat().st_size)

    def test_late_block_after_new_job_becomes_supplement(self):
        self.check_late_block("new")

    def test_late_block_after_drafted_card_becomes_supplement(self):
        self.check_late_block("ready")

    def test_late_block_after_approval_becomes_supplement(self):
        self.check_late_block("queued")

    def test_late_block_after_sharing_becomes_supplement(self):
        self.check_late_block("shared")


if __name__ == "__main__":
    unittest.main(verbosity=2)
