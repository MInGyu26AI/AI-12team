"""Synthetic engines, real PostgreSQL/HTTP; no external AI or user conversation."""
import hashlib
import json
import unittest
from unittest.mock import patch

import psycopg

from check_team_integration import TeamIntegration
from check_server_recovery import ServerRecovery
from diagnostics import check_finished, check_started, model_fingerprint
from team_records import process_checks
from team_server import authorized, verify_database

SECRET = 'SYNTHETIC_PRIVATE_TOKEN_AND_PERSONAL_TEXT_739'


class MetadataContract(unittest.TestCase):
    def test_unknown_or_malformed_coverage_never_becomes_zero(self):
        start = check_started(1, 2)
        for rows in (None, [], [None], [dict(cardId='new', judgements=[None])],
                     [dict(cardId='new', judgements=[dict(id='a'), dict(id='a')])],
                     [dict(cardId='new', judgements=[dict(id={'private': SECRET})])],
                     [dict(cardId='new', judgements=[dict(id='unexpected')])]):
            with self.subTest(rows=rows):
                result = dict(ok=True, checkStatus='complete', results=rows, error=SECRET)
                record = check_finished(start, result, 'new', {'a', 'b'}, 1, 'complete')
                self.assertIsNone(record['checked_count'])
                self.assertNotIn(SECRET, json.dumps(record))
        result = dict(ok=True, checkStatus='complete', results=[dict(cardId='new', judgements=[])])
        self.assertEqual(check_finished(check_started(1, 0), result, 'new', set(), 0, 'complete')['checked_count'], 0)
        self.assertIsNone(model_fingerprint(object()))


class DiagnosticPersistence(TeamIntegration):
    def saved(self, identifier='new', token=None, team=None):
        with authorized(self.api_dsn, token or self.tokens['Dana'], team or self.teams['A']) as (c, _):
            return c.execute('SELECT state,attempts,diagnostics FROM syncup.conflict_checks WHERE card_id=%s',
                             (identifier,)).fetchone()

    def ready(self, count=1):
        for i in range(count):
            self.publish_card('old'+str(i), SECRET + ' old ' + str(i))
        self.publish_card('todo', 'Synthetic task', tag='todo')
        with authorized(self.api_dsn, self.tokens['Dana'], self.teams['A']) as (c, _):
            c.execute("UPDATE syncup.conflict_checks SET state='complete' WHERE team_id=%s", (self.teams['A'],))
        self.publish_card('new', SECRET + ' new')

    def test_diagnostic_success_no_plaintext_and_survives_reconnect(self):
        self.ready()
        calls = []
        class Model:
            model = SECRET
            def decide(self, text, questions):
                calls.append(questions)
                return {q['name']: dict(type='choice', choice='무관', confidence=.9) for q in questions}
        with patch('team_records.from_env', return_value=None), patch('team_records.decider_from_env', return_value=Model()):
            process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        row = self.saved()
        d = row['diagnostics']
        self.assertEqual((row['state'], d['outcome'], d['candidate_count'], d['checked_count']), ('complete', 'complete', 1, 1))
        self.assertEqual(d['methods'], ['decisions'])
        self.assertEqual(len(d['policy_sha256']), 64)
        self.assertEqual(d['requested_models']['decisions'], hashlib.sha256(SECRET.encode()).hexdigest())
        self.assertGreaterEqual(d['elapsed_ms'], 0)
        self.assertGreaterEqual(d['finished_at'], d['started_at'])
        self.assertNotIn(SECRET, json.dumps(d))
        self.assertLess(len(json.dumps(d)), 1024)
        # A new DB connection/worker sees the committed snapshot, with no repeat call.
        process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        self.assertEqual(self.saved()['diagnostics'], d)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(self.saved(token=self.tokens['Bob'], team=self.teams['B']))
        with authorized(self.api_dsn, self.tokens['Bob'], self.teams['B']) as (c, _):
            self.assertEqual(c.execute("UPDATE syncup.conflict_checks SET diagnostics='{}' WHERE card_id='new'").rowcount, 0)
        board = self.team_request('GET', 'board')[1]
        self.assertNotIn('diagnostics', json.dumps(board))

    def test_diagnostic_partial_failure_is_unknown_and_not_retried(self):
        self.ready(2)
        calls = []
        class Model:
            model = 'synthetic-local-test'
            def decide(self, text, questions):
                calls.append(questions)
                return {q['name']: dict(type='choice', choice='무관', confidence=.9 if len(calls) == 1 else .4)
                        for q in questions}
        with patch('team_records.from_env', return_value=None), patch('team_records.decider_from_env', return_value=Model()):
            process_checks(self.api, self.tokens['Dana'], self.teams['A'])
            process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        d = self.saved()['diagnostics']
        self.assertEqual((d['candidate_count'], d['outcome'], len(calls)), (2, 'needs-review', 2))
        self.assertIsNone(d['checked_count'])
        self.assertNotIn(SECRET, json.dumps(d))

    def test_diagnostic_transport_limit_manual_reset_and_latest_only(self):
        self.ready()
        self.api.conflict_engine = lambda req: dict(ok=False, retryable=True, failureReason='communication', error=SECRET)
        for attempt in range(1, 4):
            process_checks(self.api, self.tokens['Dana'], self.teams['A'])
            d = self.saved()['diagnostics']
            self.assertEqual(d['attempt'], attempt)
            self.assertEqual(d['outcome'], 'retry-pending' if attempt < 3 else 'retry-exhausted')
            self.assertIsNone(d['checked_count'])
            self.assertNotIn(SECRET, json.dumps(d))
            with authorized(self.api_dsn, self.tokens['Dana'], self.teams['A']) as (c, _):
                c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 second' WHERE card_id='new'")
        self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
        self.assertEqual(self.saved()['diagnostics'], {})
        self.api.conflict_engine = lambda req: dict(ok=True, checkStatus='complete', conflicts=[])
        process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        d = self.saved()['diagnostics']
        self.assertEqual((d['attempt'], d['outcome']), (1, 'complete'))
        self.assertIsNone(d['checked_count'])  # Custom engine did not provide comparison results.
        self.assertIsNone(d['policy_sha256'])

    def test_diagnostic_exception_body_and_unknown_reason_excluded(self):
        self.ready()
        def failed(req):
            raise ValueError(SECRET)
        self.api.conflict_engine = failed
        with self.assertLogs('syncup', level='WARNING') as logs:
            process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        self.assertNotIn(SECRET, ''.join(logs.output))
        self.assertEqual(self.saved()['diagnostics']['outcome'], 'check-failed')
        self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
        self.api.conflict_engine = lambda req: dict(ok=False, failureReason=SECRET, error=SECRET)
        process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        self.assertNotIn(SECRET, json.dumps(self.saved()['diagnostics']))

    def test_diagnostic_interrupted_attempt_is_durable(self):
        self.ready()
        def interrupted(req):
            self.assertEqual(self.saved()['diagnostics']['outcome'], 'running')
            raise KeyboardInterrupt()
        self.api.conflict_engine = interrupted
        with self.assertRaises(KeyboardInterrupt):
            process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        with authorized(self.api_dsn, self.tokens['Dana'], self.teams['A']) as (c, _):
            c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 second' WHERE card_id='new'")
        process_checks(self.api, self.tokens['Dana'], self.teams['A'])
        row = self.saved()
        self.assertEqual((row['state'], row['diagnostics']['outcome']), ('failed', 'interrupted'))
        self.assertIsNone(row['diagnostics']['elapsed_ms'])
        self.assertIsNone(row['diagnostics']['checked_count'])

    def test_diagnostic_late_worker_cannot_replace_new_lease(self):
        ServerRecovery.test_late_worker_cannot_overwrite_retried_attempt_with_same_number(self)
        self.assertEqual(self.saved('late')['diagnostics'], {})  # Manual retry cleared the old attempt.

    def test_diagnostic_legacy_upgrade_twice_preserves_records(self):
        self.ready()
        with psycopg.connect(self.admin_dsn) as c:
            before = c.execute('SELECT team_id,id,packet FROM syncup.shared_cards ORDER BY id').fetchall()
            c.execute('ALTER TABLE syncup.conflict_checks DROP COLUMN diagnostics')
        with self.assertRaisesRegex(ValueError, 'migrate-integration'):
            verify_database(self.api_dsn)
        self.admin('migrate-integration')
        self.admin('migrate-integration')
        verify_database(self.api_dsn)
        self.assertEqual(self.saved()['diagnostics'], {})
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT team_id,id,packet FROM syncup.shared_cards ORDER BY id').fetchall(), before)


if __name__ == '__main__':
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(MetadataContract))
    suite.addTests(DiagnosticPersistence(name) for name in dir(DiagnosticPersistence) if name.startswith('test_diagnostic_'))
    raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
