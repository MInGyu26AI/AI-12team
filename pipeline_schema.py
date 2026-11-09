"""Local SQLite migration for the turn pipeline (integrated mode only).

Adds intake, batch context, private candidate and privacy gate tables. Existing cards and outbox rows stay;
cards loses UNIQUE(job,kind) so one batch can hold several candidates of the same kind.
"""
import json
from contextlib import closing
import sqlite3

from ai.syncup_ai.config import TURNS_PER_BATCH
import local_privacy
from storage import PRIVATE_SCHEMA, backup_before_migration, initialize

CARDS_UNIQUE = 'UNIQUE(job,kind),'
DEFAULT_OPTIONS = dict(turnsPerBatch=TURNS_PER_BATCH, projectTopic='', enabledSubtopics=[])


def _create_intake_issue_tables(c):
    c.execute('''CREATE TABLE IF NOT EXISTS intake_issues(id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
                 reason TEXT NOT NULL, message TEXT NOT NULL CHECK(json_valid(message)), received REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS intake_resolutions(issue_id TEXT PRIMARY KEY REFERENCES intake_issues(id),
                 action TEXT NOT NULL CHECK(action IN ('retry','dismiss')), replacement_id TEXT,
                 resolved REAL NOT NULL)''')


def _rebuild_cards_without_kind_limit(c):
    # Drop/recreate without renaming the old table: existing foreign keys keep referencing cards.
    if CARDS_UNIQUE not in PRIVATE_SCHEMA['cards']:
        raise ValueError('cards 스키마가 예상과 다릅니다.')
    triggers = [r[0] for r in c.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='cards'")]
    c.execute(f"CREATE TABLE cards_next ({PRIVATE_SCHEMA['cards'].replace(CARDS_UNIQUE, '')})")
    c.execute('INSERT INTO cards_next SELECT * FROM cards')
    c.execute('DROP TABLE cards')
    c.execute('ALTER TABLE cards_next RENAME TO cards')
    for sql in triggers:
        c.execute(sql)


def _create_pipeline_tables(c):
    c.execute('CREATE TABLE integration_settings(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL CHECK(json_valid(config)))')
    c.execute('INSERT INTO integration_settings VALUES(1,?)', (json.dumps(DEFAULT_OPTIONS),))
    c.execute('''CREATE TABLE job_context(job TEXT PRIMARY KEY REFERENCES jobs(id), team_id TEXT NOT NULL,
                 context TEXT NOT NULL CHECK(json_valid(context)), messages TEXT NOT NULL CHECK(json_valid(messages)))''')
    c.execute('''CREATE TABLE intake(id TEXT PRIMARY KEY, team_id TEXT NOT NULL, conversation TEXT NOT NULL,
                 message TEXT NOT NULL CHECK(json_valid(message)), job TEXT REFERENCES jobs(id), received REAL NOT NULL)''')
    c.execute('''CREATE TABLE candidate_details(id TEXT PRIMARY KEY REFERENCES cards(id), team_id TEXT NOT NULL,
                 body TEXT NOT NULL CHECK(json_valid(body)), dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)))''')
    c.execute('''CREATE TRIGGER frozen_candidate_details BEFORE UPDATE ON candidate_details
                 WHEN EXISTS(SELECT 1 FROM outbox WHERE id=OLD.id)
                 BEGIN SELECT RAISE(ABORT,'approved candidate is immutable'); END''')


def ensure_pipeline_schema(db):
    """Create or upgrade the pipeline tables; safe to call on every start."""
    initialize(db)
    with closing(sqlite3.connect(db)) as c, c:
        _create_intake_issue_tables(c)
        local_privacy.initialize(c)
        c.commit()
        if c.execute("SELECT 1 FROM sqlite_master WHERE name='integration_settings'").fetchone():
            return
        if c.execute('SELECT 1 FROM cards LIMIT 1').fetchone():  # only the cards rebuild can lose data
            backup_before_migration(db, 'integration')
        c.execute('PRAGMA foreign_keys=OFF')
        c.execute('BEGIN IMMEDIATE')
        _rebuild_cards_without_kind_limit(c)
        _create_pipeline_tables(c)
        if c.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('통합 DB 참조 오류: 변경을 취소했습니다.')
