"""Offline integration checks against synthetic Codex logs and SQLite files."""
import hashlib
import json
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import collector
from check_local_privacy import work_gate


def run_checks(root):
    start = time.time() - 60
    project = str(root / "project")
    codex = root / "codex"
    sessions = codex / "sessions"
    sessions.mkdir(parents=True)
    db = root / "private.sqlite"
    collector.initialize(db)
    with collector.connect(db) as c:
        c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (project, start, start + 600))
    with sqlite3.connect(codex / "state_5.sqlite") as c:
        c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,created_at_ms INTEGER,cwd TEXT,archived INTEGER,source TEXT DEFAULT 'cli')")

    def event(kind, payload, at=start + 10):
        return json.dumps({"type": kind, "timestamp": datetime.fromtimestamp(at, timezone.utc).isoformat(), "payload": payload}, ensure_ascii=False) + "\n"

    def add_chat(chat, cwd=project, created=start + 1, location=None, source="cli", meta_source="cli"):
        file = location or sessions / (chat + ".jsonl")
        file.write_text(event("session_meta", {"id": chat, "cwd": cwd, "source": meta_source}), encoding="utf-8")
        with sqlite3.connect(codex / "state_5.sqlite") as c:
            c.execute("INSERT INTO threads VALUES(?,?,?,?,0,?)", (chat, str(file), int(created * 1000), cwd, json.dumps(source)))
        return file

    def turn(turn_id, cwd=project, aborted=False, began=start + 10, ended=start + 11):
        return "".join([
            event("event_msg", {"type": "task_started", "turn_id": turn_id}, began),
            event("turn_context", {"cwd": cwd}, began),
            event("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "DB는 Supabase로 확정했어. 이메일 demo@example.com"}]}, began),
            event("response_item", {"type": "message", "role": "assistant", "phase": "commentary", "content": [{"type": "output_text", "text": "SHOULD_NOT_COLLECT"}]}, began),
            event("response_item", {"type": "function_call_output", "output": "TOOL_SECRET"}, began),
            event("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>IGNORE_META"}]}, began),
            event("response_item", {"type": "message", "role": "assistant", "phase": "final_answer", "content": [{"type": "output_text", "text": "연결 작업을 정리했습니다."}]}, ended),
            event("event_msg", {"type": "turn_aborted" if aborted else "task_complete", "turn_id": turn_id}, ended),
        ])

    def append(file, text):
        with file.open("a", encoding="utf-8") as f:
            f.write(text)

    def count():
        with collector.connect(db) as c:
            return c.execute("SELECT count(*) FROM jobs").fetchone()[0]

    valid = add_chat("valid")
    append(valid, turn("first"))
    collector.scan(db, codex)
    assert count() == 1
    with collector.connect(db) as c:
        job = c.execute("SELECT * FROM jobs").fetchone()
        assert job["id"] == hashlib.sha256(b"valid/first").hexdigest()
        evidence = json.loads(job["evidence"])
        assert [e["role"] for e in evidence] == ["user", "user", "assistant"]
        assert "[가림]" in evidence[1]["text"]
        assert all(s not in job["evidence"] for s in ["demo@example.com", "TOOL_SECRET", "SHOULD_NOT_COLLECT", "IGNORE_META"])
        first_job = dict(job)
    collector.scan(db, codex)
    assert count() == 1, "restart duplicate"
    partial = turn("second")
    append(valid, partial[:-7])
    collector.scan(db, codex)
    assert count() == 1, "incomplete turn collected"
    append(valid, partial[-7:])
    collector.scan(db, codex)
    assert count() == 2
    print("PASS complete turn, exact IDs, redaction, role filtering, resume and partial writes")

    for i, source in enumerate(({"subagent": {"thread_spawn": {"parent_thread_id": "parent"}}}, {"subagent": {"other": "guardian"}})):
        append(add_chat(f"child-index-{i}", source=source), turn("x"))
        append(add_chat(f"child-meta-{i}", meta_source=source), turn("x"))
    collector.scan(db, codex)
    assert count() == 2, "Codex subagent instructions collected as human evidence"
    print("PASS Codex subagents excluded by either index source or session metadata")

    append(add_chat("wrong-project", cwd="/other"), turn("x", cwd="/other"))
    append(add_chat("old", created=start - 10), turn("x"))
    append(add_chat("outside", location=root / "outside.jsonl"), turn("x"))
    append(add_chat("wrong-context"), turn("x", cwd="/other"))
    append(add_chat("aborted"), turn("x", aborted=True))
    collector.scan(db, codex)
    assert count() == 2
    with collector.connect(db) as c:
        c.execute("INSERT INTO pauses VALUES(?,?)", (start + 20, start + 30))
    append(valid, turn("paused", began=start + 19, ended=start + 21))
    collector.scan(db, codex)
    assert count() == 2
    with collector.connect(db) as c:
        c.execute("UPDATE settings SET paused=1")
    collector.scan(db, root / "absent-index")
    with collector.connect(db) as c:
        c.execute("UPDATE settings SET paused=0,end=start")
    collector.scan(db, root / "absent-index")
    assert count() == 2
    print("PASS project/path/start boundaries, abort, pause overlap and expiry")

    with collector.connect(db) as c:
        c.execute("UPDATE settings SET end=?", (start + 600,))
    def fake_api(_db, endpoint, _body):
        if endpoint == "decisions":
            return {"answers": [{"type": "predicate", "name": k, "probability": 0.95 if k in ["decision", "adopted"] else 0.01} for k in collector.QUESTIONS]}
        card = {"kind": "decision", "text": "DB로 Supabase를 사용한다.", "n": 1, "quote": "DB는 Supabase로 확정했어."}
        return {"output": [{"content": [{"type": "output_text", "text": json.dumps({"cards": [card]}, ensure_ascii=False)}]}]}
    with patch.object(collector, "call_api", side_effect=fake_api):
        collector.classify(db, first_job, work_gate())
        collector.draft(db, first_job, work_gate())
    with collector.connect(db) as c:
        card = c.execute("SELECT * FROM cards WHERE job=?", (first_job["id"],)).fetchone()
        assert card["status"] == "ready" and card["adopted"] == 1
        assert card["quote"] in evidence[0]["text"]
    print("PASS Rust jobs feed existing Python classification and grounded draft contract (mock API)")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        run_checks(Path(tmp))
