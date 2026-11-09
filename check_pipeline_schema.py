"""Pipeline schema migration and approval contract checks against real temporary SQLite files."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from card_contract import PUBLIC_FIELDS
from delivery import approve, validate_packet
from local_fixtures import public_card
from pipeline_schema import ensure_pipeline_schema
from storage import PRIVATE_SCHEMA, connect, initialize


class PipelineSchema(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name)/'private.sqlite'
        initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO jobs VALUES('j',?,'done','')", (json.dumps([dict(n=1,role='user',text='SQLite로 결정했다.')]),))
            c.execute("INSERT INTO cards VALUES('c','j','decision',1,?,?,?,'ready')", ('DB = SQLite','SQLite로 결정했다.','user'))
            c.execute("INSERT INTO sharing VALUES(1,'https://example.test/','user','team-a')")

    def details(self, guessed=False):
        ensure_pipeline_schema(self.db)
        with connect(self.db) as c:
            c.execute('INSERT INTO candidate_details VALUES(?,?,?,0)', ('c','team-a',json.dumps(dict(public_card(), evidence=dict(roleGuessed=guessed)))))

    def test_migration_retains_pending_approval_and_allows_multiple_candidates(self):
        with connect(self.db) as c:
            binding = dict(c.execute('SELECT * FROM sharing').fetchone())
            approve(c, dict(id='c',text='DB = SQLite',quote='SQLite로 결정했다.').__getitem__, binding)
            before = tuple(c.execute('SELECT * FROM outbox').fetchone())
        ensure_pipeline_schema(self.db)
        ensure_pipeline_schema(self.db)
        with connect(self.db) as c:
            self.assertEqual(tuple(c.execute('SELECT * FROM outbox').fetchone()), before)
            self.assertFalse(c.execute('PRAGMA foreign_key_check').fetchall())
            c.execute("INSERT INTO cards VALUES('c2','j','decision',1,?,?,?,'ready')", ('DB = SQLite','SQLite로 결정했다.','user'))
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("UPDATE cards SET draft='modified' WHERE id='c'")
        self.assertTrue(list(self.db.parent.glob('*.integration-*.bak.sqlite')))

    def test_public_approval_preserves_fields_and_excludes_local_evidence(self):
        self.details()
        with connect(self.db) as c:
            binding = dict(c.execute('SELECT * FROM sharing').fetchone())
            approve(c, dict(id='c',text='최종 승인',quote='SQLite로 결정했다.').__getitem__, binding)
            packet = json.loads(c.execute('SELECT payload FROM outbox').fetchone()[0])
            validate_packet(packet)
            self.assertEqual(set(packet['card']), PUBLIC_FIELDS)
            self.assertEqual(packet['card']['content'], '최종 승인')
            self.assertEqual(packet['card']['topic_key'], 'DB')
            self.assertNotIn('evidence', packet['card'])
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("UPDATE candidate_details SET dismissed=1 WHERE id='c'")

    def test_guess_or_different_team_cannot_be_approved(self):
        self.details(guessed=True)
        with connect(self.db) as c:
            binding = dict(c.execute('SELECT * FROM sharing').fetchone())
            with self.assertRaisesRegex(ValueError, '화자'):
                approve(c, dict(id='c',text='승인',quote='SQLite로 결정했다.').__getitem__, binding)
            c.execute("UPDATE sharing SET team_id='team-b'")
            binding['team_id']='team-b'
            with self.assertRaisesRegex(ValueError, '팀'):
                approve(c, dict(id='c',text='승인',quote='SQLite로 결정했다.').__getitem__, binding)
            self.assertFalse(c.execute('SELECT * FROM outbox').fetchall())

    def test_new_database_writes_no_migration_backups(self):
        fresh = Path(self.temp.name) / 'fresh' / 'private.sqlite'
        fresh.parent.mkdir()
        initialize(fresh)
        ensure_pipeline_schema(fresh)
        self.assertEqual(list(fresh.parent.glob('*.bak.sqlite')), [])
        ensure_pipeline_schema(self.db)
        self.assertEqual(len(list(self.db.parent.glob('private.sqlite.integration-*.bak.sqlite'))), 1, 'existing cards are backed up')

    def test_unexpected_cards_schema_stops_the_migration(self):
        changed = dict(PRIVATE_SCHEMA, cards=PRIVATE_SCHEMA['cards'].replace('UNIQUE(job,kind),', 'UNIQUE(job, kind),'))
        with patch.dict('pipeline_schema.PRIVATE_SCHEMA', changed), self.assertRaisesRegex(ValueError, 'cards'):
            ensure_pipeline_schema(self.db)
        with connect(self.db) as c:
            self.assertFalse(c.execute("SELECT 1 FROM sqlite_master WHERE name='integration_settings'").fetchone())

    def test_v2_rejects_hidden_fields_and_unshareable_cards(self):
        p=dict(id='c',label='결정',text='DB = SQLite',quote='SQLite로 결정했다.',speaker='사용자',version=2,card=public_card())
        validate_packet(p)
        p['card']['privateRaw']='must not be transmitted'
        with self.assertRaises(ValueError):
            validate_packet(p)
        del p['card']['privateRaw']
        p['speaker']='AI'
        with self.assertRaises(ValueError):
            validate_packet(p)


if __name__ == '__main__':
    unittest.main(verbosity=2)
