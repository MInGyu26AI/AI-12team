"""Disposable databases only: populated upgrades, backup/restore and process restart."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import json
import os
import subprocess
import unittest
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from check_pipeline_schema import PipelineSchema
from check_team_integration import TeamIntegration
from check_teams import own_tests, team_api_process
from delivery import approve
from pipeline_schema import ensure_pipeline_schema
from storage import connect
from team_access import verify_database
from team_client import TeamClient


# Catalog facts a dump/restore or upgrade must keep exactly.
CATALOG = {
    'columns': '''SELECT table_name,column_name,data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='syncup' ORDER BY 1,2''',
    'rls': '''SELECT relname,relrowsecurity,relforcerowsecurity
        FROM pg_class WHERE relnamespace='syncup'::regnamespace AND relkind='r' ORDER BY 1''',
    'policies': '''SELECT tablename,policyname,roles,cmd,qual,with_check
        FROM pg_policies WHERE schemaname='syncup' ORDER BY 1,2''',
    'grants': '''SELECT table_name,grantee,privilege_type
        FROM information_schema.table_privileges WHERE table_schema='syncup' ORDER BY 1,2,3''',
    'constraints': '''SELECT conrelid::regclass::text,conname,pg_get_constraintdef(oid)
        FROM pg_constraint WHERE connamespace='syncup'::regnamespace ORDER BY 1,2''',
}


def sqlite_rows(c):
    names = [r[0] for r in c.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {n: sorted([tuple(r) for r in c.execute('SELECT * FROM "'+n+'"')], key=repr) for n in names}


class LocalUpgrade(PipelineSchema):
    def test_populated_14_to_17_and_backup_restore(self):
        with connect(self.db) as c:
            approve(c, dict(id='c',text='DB = SQLite',quote='SQLite로 결정했다.').__getitem__,dict(c.execute('SELECT * FROM sharing').fetchone()))
        with patch('pipeline_schema.local_privacy.initialize'):
            ensure_pipeline_schema(self.db)
        with connect(self.db) as c:
            before = sqlite_rows(c)
        self.assertEqual(len(before),14)
        backup = self.db.with_name('before-upgrade.sqlite')
        with connect(self.db) as c, connect(backup) as b:
            c.backup(b)
        ensure_pipeline_schema(self.db)
        ensure_pipeline_schema(self.db)
        with connect(self.db) as c:
            after = sqlite_rows(c)
            self.assertEqual(len(after),17)
            self.assertEqual({n:after[n] for n in before},before)
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
        restored = self.db.with_name('restored.sqlite')
        with connect(backup) as b, connect(restored) as c:
            b.backup(c)
        with connect(restored) as c:
            self.assertEqual(sqlite_rows(c),before)
        ensure_pipeline_schema(restored)
        with connect(restored) as c:
            self.assertEqual(sqlite_rows(c),after)


class ServerUpgrade(TeamIntegration):
    def snapshot(self, dsn):
        """(rows of every syncup table as sorted JSON, CATALOG facts)."""
        with psycopg.connect(dsn) as c:
            names = [r[0] for r in c.execute("SELECT tablename FROM pg_tables WHERE schemaname='syncup' ORDER BY tablename")]
            rows = {}
            for name in names:
                query = sql.SQL('SELECT to_jsonb(t) FROM syncup.{} t').format(sql.Identifier(name))
                rows[name] = sorted(json.dumps(r[0], sort_keys=True) for r in c.execute(query))
            schema = {key: c.execute(query).fetchall() for key, query in CATALOG.items()}
        return rows, schema

    def restored_copy(self):
        """pg_dump the syncup schema into a new database; returns its (admin DSN, API DSN)."""
        def postgres(tool, *args, input=None):
            stdin = [] if input is None else ['-i']
            return subprocess.run(['docker', 'exec', *stdin, self.container, tool, '-U', 'postgres', *args],
                                  input=input, check=True, capture_output=True).stdout
        dump = postgres('pg_dump', '-Fc', '--schema=syncup', 'syncup_test')
        postgres('createdb', 'syncup_restore')
        postgres('pg_restore', '--exit-on-error', '-d', 'syncup_restore', input=dump)
        return make_conninfo(self.admin_dsn, dbname='syncup_restore'), make_conninfo(self.api_dsn, dbname='syncup_restore')

    def test_populated_upgrade_dump_restore_and_process_restart(self):
        self.change_after_discussion()
        self.publish_card('todo','합성 복구 점검','todo')
        self.assertEqual(self.team_request('POST','items/todo/done',dict(done=True))[0],200)
        self.assertEqual(self.team_request('POST','settings',dict(topic='합성 복구 점검 주제'))[0],200)
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('ALTER TABLE syncup.conflict_checks DROP COLUMN diagnostics')
        before,_ = self.snapshot(self.admin_dsn)
        self.assertTrue(all(before.values()),'Every table (team_settings included) must contain synthetic records')
        self.admin('migrate-integration')
        self.admin('migrate-integration')
        verify_database(self.api_dsn)
        after,schema = self.snapshot(self.admin_dsn)
        for name in before:
            values = after[name]
            if name == 'conflict_checks':
                values = []
                for text in after[name]:
                    row = json.loads(text)
                    self.assertEqual(row.pop('diagnostics'),{})
                    values.append(json.dumps(row,sort_keys=True))
                values.sort()
            self.assertEqual(values,before[name],name)
        restored_admin, restored_api = self.restored_copy()
        self.assertEqual(self.snapshot(restored_admin),(after,schema))
        verify_database(restored_api)
        # Restart the actual CLI twice against the restored DB; credentials remain local to subprocesses.
        env = dict(os.environ, SYNCUP_DATABASE_URL=restored_api)
        env.pop('SYNCUP_ADMIN_DATABASE_URL', None)
        for _ in range(2):
            with team_api_process(env) as api:
                client = TeamClient(f'http://127.0.0.1:{api.server_port}/', self.keys['Alice'])
                self.assertEqual(len(client.items(self.teams['A'])), 3)
        self.assertEqual(self.snapshot(restored_admin),(after,schema))


def load_tests(loader, tests, pattern):
    return own_tests(LocalUpgrade, ServerUpgrade)


if __name__ == '__main__':
    unittest.main(verbosity=2)
