"""Synthetic Claude Code transcripts through the real Rust scanner and local review/board."""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import time
import uuid
from unittest.mock import patch

import app
import collector
from check_local_privacy import work_gate
import delivery
from check_integrity import post, server


def run_checks(root):
    project = str(root / "project")
    start = time.time() - 300
    db = root / "private.sqlite"
    claude = root / "claude"
    folder = claude / "projects" / re.sub("[^a-zA-Z0-9]", "-", project)
    folder.mkdir(parents=True)
    collector.initialize(db)
    with collector.connect(db) as c:
        c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (project, start, start + 600))
    missing_codex = root / "codex"

    def rows():
        with collector.connect(db) as c:
            return [dict(r) for r in c.execute("SELECT * FROM jobs ORDER BY rowid")]

    def scan():
        collector.scan(db, missing_codex, claude)

    def event(session, kind, ident, parent, content, at, **extra):
        from datetime import datetime, timezone
        message = dict(role=kind, content=content)
        if kind == "assistant":
            message.update(id="model-" + ident, stop_reason="end_turn")
        message.update(extra.pop("message", {}))
        return json.dumps(dict(type=kind, uuid=ident, parentUuid=parent, sessionId=session,
            cwd=project, timestamp=datetime.fromtimestamp(start+at, timezone.utc).isoformat(),
            message=message, **extra), ensure_ascii=False) + "\n"

    def transcript(session, suffix="1", begin=20, end=30, parent=None):
        return "".join([
            event(session, "user", "u"+suffix, parent, "DB는 Supabase로 확정했어. 연락처 demo@example.com", begin),
            event(session, "assistant", "tool"+suffix, "u"+suffix,
                [dict(type="text",text="COMMENTARY_NOT_EVIDENCE"),dict(type="tool_use",id="tool",input={"secret":"TOOL_SECRET"})],
                begin+1, message={"stop_reason":"tool_use"}),
            event(session, "user", "result"+suffix, "tool"+suffix,
                [dict(type="tool_result",content="TOOL_RESULT_SECRET")], begin+2),
            event(session, "assistant", "a"+suffix, "result"+suffix,
                [dict(type="thinking",thinking="PRIVATE_THOUGHT"),dict(type="text",text="Supabase 연결을 진행하겠습니다.")], end),
        ])

    def write(session, content, append=False):
        path = folder / (session + ".jsonl")
        with path.open("a" if append else "w", encoding="utf-8") as f:
            f.write(content)
        return path

    session = str(uuid.uuid4())
    path = write(session, transcript(session))
    scan()
    assert len(rows()) == 1
    job = rows()[0]
    assert job["id"] == hashlib.sha256(f"claude-code/{session}/model-a1".encode()).hexdigest()
    evidence = json.loads(job["evidence"])
    assert [e["role"] for e in evidence] == ["user","user","assistant"]
    assert all(e["source"] == "claude-code" and e["session_id"] == session for e in evidence)
    assert all(s not in job["evidence"] for s in ("demo@example.com","TOOL_SECRET","TOOL_RESULT_SECRET","PRIVATE_THOUGHT","COMMENTARY_NOT_EVIDENCE"))
    assert "[가림]" in job["evidence"]
    scan()
    assert len(rows()) == 1
    partial = transcript(session,"2",40,50,parent="a1")
    write(session,partial[:-10],True)
    scan()
    assert len(rows()) == 1
    write(session,partial[-10:],True)
    scan()
    assert len(rows()) == 2
    assert {e["message_id"] for e in json.loads(rows()[1]["evidence"])} == {"u2","a2"}
    print("PASS Claude final turns, namespace/provenance, masking, tools/thinking exclusion, partial writes and duplicate scans")

    old = str(uuid.uuid4())
    write(old,transcript(old,begin=-50,end=-40)+transcript(old,"new",60,70,parent="a1"))
    wrong = str(uuid.uuid4())
    write(wrong,transcript(wrong).replace(json.dumps(project,ensure_ascii=False),json.dumps("/other-project")))
    side = str(uuid.uuid4())
    write(side,transcript(side).replace('"cwd":', '"isSidechain": true, "cwd":'))
    noend = str(uuid.uuid4())
    write(noend,transcript(noend).replace('"end_turn"','null'))
    nested = folder / session / "subagents"
    nested.mkdir(parents=True)
    (nested/(str(uuid.uuid4())+".jsonl")).write_text(transcript(session), encoding="utf-8")
    external = root / "outside.jsonl"
    external.write_text(transcript(str(uuid.uuid4())), encoding="utf-8")
    (folder/(str(uuid.uuid4())+".jsonl")).symlink_to(external)
    scan()
    assert len(rows()) == 2
    print("PASS old/resumed histories, other projects, sidechains, subagent files, symlinks and unknown completion excluded")

    split = str(uuid.uuid4())
    write(split, event(split,"user","split-u",None,"새 구현은 파랑으로 정했어.",35)
          +event(split,"assistant","split-a1","split-u",[dict(type="text",text="첫 번째 답변.")],36,message={"id":"same-response"})
          +event(split,"assistant","split-a2","split-a1",[dict(type="text",text="두 번째 답변.")],37,message={"id":"same-response"}))
    compact = str(uuid.uuid4())
    write(compact,event(compact,"user","summary",None,"SUMMARY_NOT_HUMAN",36,isCompactSummary=True)
          +event(compact,"assistant","summary-a","summary",[dict(type="text",text="SUMMARY_REPLY")],37)
          +event(compact,"user","fresh-u","summary-a","현재 결정만 기록해.",38)
          +event(compact,"assistant","fresh-a","fresh-u",[dict(type="text",text="현재 결정을 정리했습니다.")],39))
    scan()
    assert len(rows()) == 4
    split_rows = [r for r in rows() if split in r["evidence"]]
    assert len(split_rows) == 1 and len(json.loads(split_rows[0]["evidence"])) == 3
    assert all("SUMMARY_NOT_HUMAN" not in r["evidence"] and "SUMMARY_REPLY" not in r["evidence"] for r in rows())
    print("PASS split final response grouped once; compaction summary excluded and later genuine prompt accepted")

    with collector.connect(db) as c:
        c.execute("INSERT INTO pauses VALUES(?,?)", (start+85,start+90))
    paused = str(uuid.uuid4())
    write(paused,transcript(paused,begin=80,end=95))
    born_paused = str(uuid.uuid4())
    write(born_paused,transcript(born_paused,begin=86,end=95)+transcript(born_paused,"later",100,110,parent="a1"))
    scan()
    assert len(rows()) == 4
    with collector.connect(db) as c:
        c.execute("UPDATE settings SET paused=1")
    write(session,transcript(session,"3",120,130,parent="a2"),True)
    scan()
    assert len(rows()) == 4
    with collector.connect(db) as c:
        c.execute("UPDATE settings SET paused=0,end=start")
    scan()
    assert len(rows()) == 4
    with collector.connect(db) as c:
        c.execute("UPDATE settings SET end=?", (start+600,))
    scan()
    assert len(rows()) == 5
    print("PASS pause overlap, sessions born during pause, active pause and expiry")

    with collector.connect(db) as c:
        old_cursor = c.execute("SELECT pos FROM cursors WHERE chat=?",("claude-code/"+session,)).fetchone()[0]
        c.execute("CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    write(session,transcript(session,"4",140,150,parent="a3"),True)
    try:
        scan()
    except ValueError:
        pass
    else:
        raise AssertionError("scanner hid failed write")
    with collector.connect(db) as c:
        assert c.execute("SELECT pos FROM cursors WHERE chat=?",("claude-code/"+session,)).fetchone()[0] == old_cursor
        c.execute("DROP TRIGGER fail_job")
    scan()
    assert len(rows()) == 6
    print("PASS failed job insert rolls back cursor; retry imports exactly once")

    # A broken Codex source must not suppress valid Claude input or processing.
    missing_codex.mkdir()
    with sqlite3.connect(missing_codex / "state_5.sqlite") as c:
        c.execute("CREATE TABLE unexpected(x)")
    write(session,transcript(session,"5",160,170,parent="a4"),True)
    try:
        scan()
    except ValueError:
        pass
    assert len(rows()) == 7
    with (patch.object(app,"scan",side_effect=ValueError("source unavailable")), patch.object(app,"process") as process,
          patch.object(app.time,"sleep",side_effect=RuntimeError("stop test loop"))):
        try:
            app.watch(db,missing_codex,claude)
        except RuntimeError:
            pass
        process.assert_called_once_with(db)
    print("PASS source failure isolation and continued processing of valid jobs")

    def fake_api(_db, endpoint, _body):
        if endpoint == "decisions":
            return {"answers":[dict(type="predicate",name=k,probability=.95 if k in ("decision","adopted") else .01) for k in collector.QUESTIONS]}
        card = dict(kind="decision",text="DB로 Supabase를 사용한다.",n=1,quote="DB는 Supabase로 확정했어.")
        return dict(output=[dict(content=[dict(type="output_text",text=json.dumps(dict(cards=[card])))])])
    with patch.object(collector,"call_api",side_effect=fake_api):
        collector.classify(db,job,work_gate())
        collector.draft(db,job,work_gate())
    board = root / "board.sqlite"
    collector.initialize(board,board=True)
    with server(app.Review,db) as review, server(app.Board,board) as board_server:
        assert post(review,"/approve",dict(id=job["id"]+"-decision",text="Supabase를 사용한다.",quote="DB는 Supabase로 확정했어."))[0] == 303
        delivery.deliver(db,board_server.board_url,board_server.secret)
    with collector.connect(board) as c:
        assert c.execute("SELECT count(*) FROM records").fetchone()[0] == 1
    print("PASS Claude input → mock AI → review HTTP approval → durable queue → real loopback board")

    from datetime import datetime, timezone
    sessions = missing_codex / "sessions"
    sessions.mkdir()
    codex_log = sessions / (session + ".jsonl")
    def codex_event(kind, payload, at):
        return json.dumps(dict(type=kind,payload=payload,timestamp=datetime.fromtimestamp(start+at,timezone.utc).isoformat()))+"\n"
    codex_log.write_text("".join([
        codex_event("session_meta",dict(id=session,cwd=project),180),
        codex_event("event_msg",dict(type="task_started",turn_id="codex-turn"),181),
        codex_event("turn_context",dict(cwd=project),181),
        codex_event("response_item",dict(type="message",role="user",content=[dict(type="input_text",text="Codex에서도 연결할게.")]),182),
        codex_event("event_msg",dict(type="task_complete",turn_id="codex-turn"),190),
    ]))
    with sqlite3.connect(missing_codex / "state_5.sqlite") as c:
        c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,created_at_ms INTEGER,cwd TEXT,archived INTEGER,source TEXT)")
        c.execute("INSERT INTO threads VALUES(?,?,?,?,0,'cli')",(session,str(codex_log),int((start+180)*1000),project))
    scan()
    assert len(rows()) == 8
    with collector.connect(db) as c:
        assert c.execute("SELECT count(*) FROM cursors WHERE chat IN (?,?)",(session,"claude-code/"+session)).fetchone()[0] == 2
    scan()
    assert len(rows()) == 8
    print("PASS Codex and Claude coexist in one database; identical session names keep independent cursors")


def check_late_blocks(root):
    from datetime import datetime, timezone
    for state in ("new", "ready", "queued", "shared"):
        project = str(root / state)
        start = time.time()-60
        db = root / (state+".sqlite")
        claude = root / (state+"-claude")
        folder = claude / "projects" / re.sub("[^a-zA-Z0-9]", "-", project)
        folder.mkdir(parents=True)
        collector.initialize(db)
        with collector.connect(db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (project,start,start+600))
        session = str(uuid.uuid4())
        path = folder / (session+".jsonl")
        def append(ident, parent, role, text, offset):
            message = dict(role=role,content=[dict(type="text",text=text)])
            if role == "assistant": message.update(id="one-response",stop_reason="end_turn")
            with path.open("a", encoding="utf-8") as out:
                out.write(json.dumps(dict(type=role,uuid=ident,parentUuid=parent,sessionId=session,cwd=project,
                    timestamp=datetime.fromtimestamp(start+offset,timezone.utc).isoformat(),message=message))+"\n")
        def scan(): collector.scan(db,root/"absent-codex",claude)
        append("u",None,"user","배포 방식을 확인해줘.",1)
        append("a1","u","assistant","FIRST_BLOCK",2)
        scan()
        with collector.connect(db) as c:
            original = dict(c.execute("SELECT * FROM jobs").fetchone())
            if state != "new":
                c.execute("UPDATE jobs SET state='done'")
                c.execute("INSERT INTO cards VALUES(?,?,'decision',0,'original draft','FIRST_BLOCK','assistant','ready')", (original["id"]+"-decision",original["id"]))
                if state in ("queued", "shared"):
                    delivery.approve(c,dict(id=original["id"]+"-decision",text="사용자가 승인한 내용",quote="FIRST_BLOCK").__getitem__)
                if state == "shared":
                    c.execute("UPDATE cards SET status='shared'")
                    c.execute("UPDATE outbox SET state='sent'")
            before = {t:[tuple(r) for r in c.execute(f"SELECT * FROM {t}")] for t in ("jobs","cards","outbox")}
            old_cursor = c.execute("SELECT pos FROM cursors").fetchone()[0]
        append("a2","a1","assistant","LATE_BLOCK",3)
        with collector.connect(db) as c:
            c.execute("CREATE TRIGGER fail_late BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
        try: scan()
        except ValueError: pass
        else: raise AssertionError("failed late insert did not report failure")
        with collector.connect(db) as c:
            assert c.execute("SELECT pos FROM cursors").fetchone()[0] == old_cursor
            c.execute("DROP TRIGGER fail_late")
        scan()
        with collector.connect(db) as c:
            jobs = [dict(r) for r in c.execute("SELECT * FROM jobs ORDER BY rowid")]
            assert len(jobs) == 2, "late Claude block lost on duplicate response id"
            for t in ("cards","outbox"):
                assert [tuple(r) for r in c.execute(f"SELECT * FROM {t}")] == before[t]
            assert tuple(c.execute("SELECT * FROM jobs WHERE id=?",(original["id"],)).fetchone()) == before["jobs"][0]
            extra = json.loads(jobs[1]["evidence"])
            assert [(e["n"],e["role"],e["text"]) for e in extra] == [(1,"assistant","LATE_BLOCK")]
            assert extra[0]["message_id"] == "a2"
        # Even a mistaken model adoption score cannot turn an AI-only supplement into human approval.
        answer = {"answers":[dict(type="predicate",name=k,probability=0.99 if k in ("decision","adopted") else 0.01) for k in collector.QUESTIONS]}
        with patch.object(collector,"call_api",return_value=answer): collector.classify(db,jobs[1],work_gate())
        with collector.connect(db) as c:
            assert c.execute("SELECT adopted FROM cards WHERE job=?",(jobs[1]["id"],)).fetchone()[0] == 0
        append("a3","a2","assistant","THIRD_BLOCK",4)
        scan()
        scan()
        with collector.connect(db) as c:
            jobs = [dict(r) for r in c.execute("SELECT * FROM jobs ORDER BY rowid")]
            assert len(jobs) == 3
            assert [e["text"] for e in json.loads(jobs[2]["evidence"])] == ["THIRD_BLOCK"]
            assert c.execute("SELECT pos FROM cursors").fetchone()[0] == path.stat().st_size
    print("PASS late Claude blocks survive separate scans, retries and restarts without changing prior evidence or approvals")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        run_checks(Path(tmp).resolve())
    with tempfile.TemporaryDirectory() as tmp:
        check_late_blocks(Path(tmp).resolve())
