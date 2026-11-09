"""Offline intake, independent rejection, fresh approval and sanitized diagnostics."""
import json
import sqlite3
import unittest
from unittest.mock import patch

from batch_classification import classify_queued
from candidate_review import list_candidates
import collection_loop
from collection_settings import configure
from collection_status import collection_status
from diagnostics import failure
from local_fixtures import PipelineFixture
from local_rpc import dispatch
from storage import connect
import turn_intake
from turn_pipeline import TurnPipeline


class LocalRecovery(PipelineFixture):
    def test_offline_append_status_flush_restart_and_approval_denial(self):
        with patch.object(self.pipeline.client, 'me', side_effect=OSError('OFFLINE_SECRET')):
            self.assertEqual(turn_intake.append(self.pipeline, [self.message()])['newMessages'], 1)
            self.assertEqual(collection_status(self.pipeline)['teamId'], 'a')
            dispatch(self.pipeline, 'collection.flush', {})
            turn_intake.capture_scanned_jobs(self.pipeline)
            classify_queued(self.pipeline)
            card = list_candidates(self.pipeline)[0]['id']
            restarted = TurnPipeline(self.db, self.pipeline.client)
            self.assertEqual(len(dispatch(restarted, 'candidates.list', {})['cards']), 1)
            with self.assertRaises(OSError):
                dispatch(restarted, 'candidates.approve', dict(ids=[card], teamId='a'))
            with self.assertRaises(OSError):
                configure(restarted, dict(teamId='b'))
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM intake').fetchone()[0], 1)
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0], 0)

    def test_invalid_and_changed_neighbors_are_preserved_idempotently(self):
        turn_intake.append(self.pipeline, [self.message()])
        changed = dict(self.message(), text='PostgreSQL로 변경했다.')
        invalid = dict(self.message('bad'), role='unknown')
        response = turn_intake.append(self.pipeline, [changed, invalid, self.message('two')])
        self.assertEqual(response['newMessages'], 1)
        self.assertEqual({i['reason'] for i in response['intakeIssues']}, {'message_changed','invalid_message'})
        self.assertEqual({i['messageId'] for i in response['intakeIssues']}, {'one','bad'})
        turn_intake.append(self.pipeline, [changed, invalid, self.message('two')])
        self.assertEqual(len(collection_status(self.pipeline)['intakeIssues']), 2)
        self.assertEqual(len(dispatch(self.pipeline, 'intake.issues', {})['items']), 2)
        with connect(self.db) as c:
            messages = [json.loads(r[0]) for r in c.execute('SELECT message FROM intake')]
        self.assertEqual({m['id'] for m in messages}, {'one','two'})
        self.assertTrue(all(m['text']=='SQLite로 결정했다.' for m in messages))
        configure(self.pipeline, dict(teamId='b'))
        self.assertEqual(dispatch(self.pipeline, 'intake.issues', {})['items'], [])

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
            dispatch(self.pipeline, 'candidates.approve', dict(ids=[card], teamId='a'))
            configure(self.pipeline, dict(teamId='b'))
        self.assertEqual(len(calls), 2)

    def test_diagnostic_never_logs_exception_body_or_raw_trace(self):
        with self.assertLogs('syncup', level='WARNING') as captured:
            failure('classification', ValueError('PRIVATE_SECRET_BODY'), 'PRIVATE_TRACE')
        self.assertNotIn('PRIVATE', ''.join(captured.output))
        self.assertIn('classification', captured.output[0])
        self.assertIn('ValueError', captured.output[0])

    def test_local_capture_failure_does_not_block_saved_jobs(self):
        turn_intake.append(self.pipeline, [self.message()], True)
        with patch('collection_loop.scan'), patch('collection_loop.process'), \
             patch('collection_loop.time.sleep',side_effect=InterruptedError), \
             patch('collection_loop.turn_intake.capture_scanned_jobs',side_effect=ValueError('PRIVATE_INPUT')):
            with self.assertLogs('syncup',level='WARNING'), self.assertRaises(InterruptedError):
                collection_loop.watch(self.db,None,pipeline=self.pipeline)
        self.assertEqual(len(list_candidates(self.pipeline)),1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
