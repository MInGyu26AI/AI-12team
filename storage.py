"""SQLite transactions, versioned schema and single-process state ownership."""
from contextlib import contextmanager
import errno
import os
import sqlite3
import tempfile
import sys
from pathlib import Path


@contextmanager
def connect(path):
    c = sqlite3.connect(path, timeout=10)
    c.row_factory = sqlite3.Row
    try:
        c.execute("PRAGMA foreign_keys=ON")
        with c:
            yield c
    finally:
        c.close()


@contextmanager
def runtime_lock(path):
    # Keep the file: unlinking a held lock would allow a second owner.
    with open(path, "a+b") as lock:
        if sys.platform == "win32":
            import msvcrt
            lock.seek(0)
            acquire = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            release = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            acquire = lambda: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            release = lambda: fcntl.flock(lock, fcntl.LOCK_UN)
        try:
            acquire()
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            raise SystemExit("같은 상태 폴더의 프로그램이 이미 실행 중입니다.") from None
        try:
            yield
        finally:
            release()


# Text limits (1200) and board labels repeat card_contract.MAX_TEXT, KIND_LABELS and UNADOPTED_LABEL.
PRIVATE_SCHEMA = {
    "settings": """id INTEGER PRIMARY KEY CHECK(id=1), project TEXT NOT NULL,
        start REAL NOT NULL CHECK(start>=0), end REAL NOT NULL CHECK(end>=start),
        paused INTEGER NOT NULL CHECK(paused IN (0,1)), status TEXT NOT NULL""",
    "cursors": "chat TEXT PRIMARY KEY NOT NULL, pos INTEGER NOT NULL CHECK(pos>=0)",
    "pauses": "start REAL PRIMARY KEY NOT NULL, end REAL CHECK(end>=start)",
    "jobs": """id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 1200),
        evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='array'),
        state TEXT NOT NULL CHECK(state IN ('new','draft','done','failed_new','failed_draft')),
        detail TEXT NOT NULL""",
    "cards": """id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 1200),
        job TEXT NOT NULL REFERENCES jobs(id),
        kind TEXT NOT NULL CHECK(kind IN ('decision','research','task')),
        adopted INTEGER NOT NULL CHECK(adopted IN (0,1)), draft TEXT, quote TEXT,
        role TEXT CHECK(role IN ('user','assistant')),
        status TEXT NOT NULL CHECK(status IN ('drafting','manual','ready','queued','shared')),
        UNIQUE(job,kind),
        CHECK(status IN ('drafting','manual') OR
          (draft IS NOT NULL AND length(trim(draft)) BETWEEN 1 AND 1200 AND
           quote IS NOT NULL AND length(trim(quote)) BETWEEN 1 AND 1200 AND role IS NOT NULL))""",
    "outbox": """id TEXT PRIMARY KEY NOT NULL REFERENCES cards(id),
        payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object'
          AND json_extract(payload,'$.id') IS id),
        state TEXT NOT NULL CHECK(state IN ('pending','sent','blocked')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
        next_attempt REAL NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '',
        created REAL NOT NULL""",
}
BOARD_SCHEMA = {
    "records": """id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 1200),
        label TEXT NOT NULL CHECK(label IN ('결정','결정 · 채택 미확인','조사','할 일')),
        text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 1200),
        quote TEXT NOT NULL CHECK(length(trim(quote)) BETWEEN 1 AND 1200),
        speaker TEXT NOT NULL CHECK(speaker IN ('사용자','AI'))""",
}


def backup_before_migration(db, tag):
    """Copy db to <name>.<tag>-XXXX.bak.sqlite next to it before a schema change; retention drops it after 7 days.

    A separate reader can back up while the caller's connection reserves the write lock.
    """
    fd, backup = tempfile.mkstemp(prefix=f"{Path(db).name}.{tag}-", suffix=".bak.sqlite", dir=Path(db).parent)
    os.close(fd)
    with connect(db) as source, connect(backup) as dest:
        source.backup(dest)


def initialize(db, board=False):
    initialize_v1(db, board)
    if board:
        return
    with connect(db) as c:
        c.execute("BEGIN IMMEDIATE")
        if c.execute("PRAGMA user_version").fetchone()[0] == 2:
            return
        backup_before_migration(db, "v1")
        c.execute("""CREATE TABLE sharing(id INTEGER PRIMARY KEY CHECK(id=1),
            api_url TEXT NOT NULL, user_id TEXT NOT NULL, team_id TEXT)""")
        c.execute("""CREATE TRIGGER frozen_identity BEFORE UPDATE OF api_url,user_id ON sharing
            BEGIN SELECT RAISE(ABORT,'sharing identity is immutable'); END""")
        c.execute("""CREATE TRIGGER keep_identity BEFORE DELETE ON sharing
            BEGIN SELECT RAISE(ABORT,'sharing identity is immutable'); END""")
        c.execute("""CREATE TABLE outbox_destinations(id TEXT PRIMARY KEY NOT NULL REFERENCES outbox(id),
            api_url TEXT NOT NULL, user_id TEXT NOT NULL, team_id TEXT NOT NULL)""")
        for action in ('UPDATE', 'DELETE'):
            c.execute(f"""CREATE TRIGGER frozen_destination_{action.lower()} BEFORE {action} ON outbox_destinations
                BEGIN SELECT RAISE(ABORT,'approved destination is immutable'); END""")
        c.execute("PRAGMA user_version=2")


def initialize_v1(db, board=False):
    """Create the version 1 schema, or convert unversioned tables to it."""
    schema = BOARD_SCHEMA if board else PRIVATE_SCHEMA
    with connect(db) as c:
        c.execute("BEGIN IMMEDIATE")
        version = c.execute("PRAGMA user_version").fetchone()[0]
        if version == 1 or (version == 2 and not board):
            return
        if version != 0:
            raise ValueError("지원하지 않는 DB 버전입니다.")
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        legacy = set(schema) - ({"outbox"} if not board else set())
        if tables and tables != legacy:
            raise ValueError("기존 DB 구성을 확인해 주세요. 자동 변경하지 않았습니다.")
        if tables:
            backup_before_migration(db, "v0")
            for name in schema:
                if name in tables:
                    c.execute(f"ALTER TABLE {name} RENAME TO {name}_legacy")
        for name, columns in schema.items():
            c.execute(f"CREATE TABLE {name} ({columns})")
            if name in tables:
                c.execute(f"INSERT INTO {name} SELECT * FROM {name}_legacy ORDER BY rowid")
        for name in reversed(list(schema)):
            if name in tables:
                c.execute(f"DROP TABLE {name}_legacy")
        if not board:
            c.execute("""CREATE TRIGGER frozen_payload BEFORE UPDATE OF id,payload,created ON outbox
                BEGIN SELECT RAISE(ABORT,'approved payload is immutable'); END""")
            c.execute("""CREATE TRIGGER frozen_card BEFORE UPDATE ON cards
                WHEN OLD.status IN ('queued','shared') AND
                  (NEW.id IS NOT OLD.id OR NEW.job IS NOT OLD.job OR NEW.kind IS NOT OLD.kind
                   OR NEW.adopted IS NOT OLD.adopted OR NEW.draft IS NOT OLD.draft
                   OR NEW.quote IS NOT OLD.quote OR NEW.role IS NOT OLD.role
                   OR NEW.status NOT IN ('queued','shared')
                   OR (OLD.status='shared' AND NEW.status!='shared'))
                BEGIN SELECT RAISE(ABORT,'approved card is immutable'); END""")
        if c.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("기존 DB 참조 오류입니다. 변환을 취소했습니다.")
        c.execute("PRAGMA user_version=1")
