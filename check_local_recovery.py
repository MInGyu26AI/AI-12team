"""Offline intake, independent rejection, fresh approval and sanitized diagnostics."""
import json
import sqlite3
import unittest
from unittest.mock import patch

import check_pipeline
from diagnostics import failure
from integration import Pipeline
from storage import connect


class LocalRecovery(unittest.TestCase):
    setUp = check_pipeline.PipelineTest.setUp
    message = check_pipeline.PipelineTest.message
    candidate = check_pipeline.PipelineTest.candidate

    def test_offline_append_status_flush_restart_and_approval_denial(self):
        with patch.object(self.pipeline.client, 'me', side_effect=OSError('OFFLINE_SECRET')):
            self.assertEqual(self.pipeline.append([self.message()])['newMessages'], 1)
            self.assertEqual(self.pipeline.status()['teamId'], 'a')
            self.pipeline.rpc('collection.flush', {})
            self.pipeline.capture_local_jobs()
            self.pipeline.process()
            card = self.pipeline.candidates()[0]['id']
            restarted = Pipeline(self.db, self.pipeline.client)
            self.assertEqual(len(restarted.rpc('candidates.list', {})['cards']), 1)
            with self.assertRaises(OSError):
                restarted.rpc('candidates.approve', dict(ids=[card], teamId='a'))
            with self.assertRaises(OSError):
                restarted.configure(dict(teamId='b'))
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM intake').fetchone()[0], 1)
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0], 0)

    def test_invalid_and_changed_neighbors_are_preserved_idempotently(self):
        self.pipeline.append([self.message()])
        changed = dict(self.message(), text='PostgreSQL로 변경했다.')
        invalid = dict(self.message('bad'), role='unknown')
        response = self.pipeline.append([changed, invalid, self.message('two')])
        self.assertEqual(response['newMessages'], 1)
        self.assertEqual({i['reason'] for i in response['intakeIssues']}, {'message_changed','invalid_message'})
        self.assertEqual({i['messageId'] for i in response['intakeIssues']}, {'one','bad'})
        self.pipeline.append([changed, invalid, self.message('two')])
        self.assertEqual(len(self.pipeline.status()['intakeIssues']), 2)
        self.assertEqual(len(self.pipeline.rpc('intake.issues', {})['items']), 2)
        with connect(self.db) as c:
            messages = [json.loads(r[0]) for r in c.execute('SELECT message FROM intake')]
        self.assertEqual({m['id'] for m in messages}, {'one','two'})
        self.assertTrue(all(m['text']=='SQLite로 결정했다.' for m in messages))
        self.pipeline.configure(dict(teamId='b'))
        self.assertEqual(self.pipeline.rpc('intake.issues', {})['items'], [])

    def test_network_preflight_holds_no_sqlite_write_lock(self):
        original = self.pipeline.client.me
        calls = []
        def probe():
            with sqlite3.connect(self.db, timeout=.01) as c:
                c.execute('BEGIN IMMEDIATE')
                calls.append(True)
            return original()
        card = self.candidate()
        with patch.object(self.pipeline.client, 'me', side_effect=probe):
            self.pipeline.rpc('candidates.approve', dict(ids=[card], teamId='a'))
            self.pipeline.configure(dict(teamId='b'))
        self.assertEqual(len(calls), 2)

    def test_diagnostic_never_logs_exception_body_or_raw_trace(self):
        with self.assertLogs('syncup', level='WARNING') as captured:
            failure('classification', ValueError('PRIVATE_SECRET_BODY'), 'PRIVATE_TRACE')
        self.assertNotIn('PRIVATE', ''.join(captured.output))
        self.assertIn('classification', captured.output[0])
        self.assertIn('ValueError', captured.output[0])

    def test_local_capture_failure_does_not_block_saved_jobs(self):
        import app
        self.pipeline.append([self.message()], True)
        with patch('app.scan'), patch('app.process'), patch('app.time.sleep',side_effect=InterruptedError), \
             patch.object(self.pipeline,'capture_local_jobs',side_effect=ValueError('PRIVATE_INPUT')):
            with self.assertLogs('syncup',level='WARNING'), self.assertRaises(InterruptedError):
                app.watch(self.db,None,pipeline=self.pipeline)
        self.assertEqual(len(self.pipeline.candidates()),1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
