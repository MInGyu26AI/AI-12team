"""Opt-in migration: preserve existing cards/outbox while allowing multiple same-tag candidates."""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import tempfile

import local_privacy
from storage import PRIVATE_SCHEMA, initialize


def initialize_integration(db):
    initialize(db)
    with closing(sqlite3.connect(db)) as c, c:
        c.execute('''CREATE TABLE IF NOT EXISTS intake_issues(id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
                     reason TEXT NOT NULL, message TEXT NOT NULL CHECK(json_valid(message)), received REAL NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS intake_resolutions(issue_id TEXT PRIMARY KEY REFERENCES intake_issues(id),
                     action TEXT NOT NULL CHECK(action IN ('retry','dismiss')), replacement_id TEXT,
                     resolved REAL NOT NULL)''')
        local_privacy.initialize(c)
        c.commit()
        if c.execute("SELECT 1 FROM sqlite_master WHERE name='integration_settings'").fetchone():
            return
        fd, backup = tempfile.mkstemp(prefix=Path(db).name + '.integration-', suffix='.bak.sqlite', dir=Path(db).parent)
        os.close(fd)
        with closing(sqlite3.connect(backup)) as dest, dest:
            c.backup(dest)
        # Drop/recreate without renaming the old table: existing foreign keys keep referencing cards.
        c.execute('PRAGMA foreign_keys=OFF')
        c.execute('BEGIN IMMEDIATE')
        triggers = [r[0] for r in c.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='cards'")]
        columns = PRIVATE_SCHEMA['cards'].replace('UNIQUE(job,kind),', '')
        c.execute(f'CREATE TABLE cards_next ({columns})')
        c.execute('INSERT INTO cards_next SELECT * FROM cards')
        c.execute('DROP TABLE cards')
        c.execute('ALTER TABLE cards_next RENAME TO cards')
        for sql in triggers:
            c.execute(sql)
        c.execute('CREATE TABLE integration_settings(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL CHECK(json_valid(config)))')
        c.execute('INSERT INTO integration_settings VALUES(1,?)', (json.dumps(dict(turnsPerBatch=10, projectTopic='', enabledSubtopics=[])),))
        c.execute('''CREATE TABLE job_context(job TEXT PRIMARY KEY REFERENCES jobs(id), team_id TEXT NOT NULL,
                     context TEXT NOT NULL CHECK(json_valid(context)), messages TEXT NOT NULL CHECK(json_valid(messages)))''')
        c.execute('''CREATE TABLE intake(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, conversation TEXT NOT NULL,
                     message TEXT NOT NULL CHECK(json_valid(message)), job TEXT REFERENCES jobs(id), received REAL NOT NULL)''')
        c.execute('''CREATE TABLE candidate_details(id TEXT PRIMARY KEY REFERENCES cards(id), team_id TEXT NOT NULL,
                     body TEXT NOT NULL CHECK(json_valid(body)), dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)))''')
        c.execute('''CREATE TRIGGER frozen_candidate_details BEFORE UPDATE ON candidate_details
                     WHEN EXISTS(SELECT 1 FROM outbox WHERE id=OLD.id)
                     BEGIN SELECT RAISE(ABORT,'approved candidate is immutable'); END''')
        if c.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('통합 DB 참조 오류: 변경을 취소했습니다.')
