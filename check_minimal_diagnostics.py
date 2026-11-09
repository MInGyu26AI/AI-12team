"""Synthetic engines, real PostgreSQL/HTTP; no external AI or user conversation."""
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from check_team_integration import TeamIntegration, checked, decisions_model
from check_teams import own_tests
from conflict_checks import current_policy
from diagnostics import check_finished, check_started, checked_count, conflict_policy_fingerprint, model_fingerprint

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
                self.assertIsNone(checked_count(result, 'new', {'a', 'b'}))
                self.assertNotIn(SECRET, json.dumps(record))
        result = dict(ok=True, checkStatus='complete', results=[dict(cardId='new', judgements=[])])
        self.assertEqual(check_finished(check_started(1, 0), result, 'new', set(), 0, 'complete')['checked_count'], 0)
        self.assertIsNone(model_fingerprint(object()))

    def test_policy_fingerprint_reads_settings_loaded_after_import(self):
        # team_server.py imports conflict_checks before main() loads ai/.env into the environment.
        current_policy.cache_clear()
        self.addCleanup(current_policy.cache_clear)
        before = conflict_policy_fingerprint()
        with patch.dict(os.environ, AI_MODEL='synthetic-model-from-dotenv'):
            self.assertEqual(current_policy(), conflict_policy_fingerprint())
            self.assertNotEqual(current_policy(), before)

    def test_unreadable_policy_source_is_logged(self):
        with patch.object(Path, 'read_bytes', side_effect=OSError(SECRET)), \
                self.assertLogs('syncup', level='WARNING') as logs:
            self.assertIsNone(conflict_policy_fingerprint())
        self.assertIn('conflict_policy', logs.output[0])
        self.assertNotIn(SECRET, ''.join(logs.output))


class DiagnosticPersistence(TeamIntegration):
    def saved(self, identifier='new', user='Dana', team='A'):
        with self.team_db(user, team) as c:
            return c.execute('SELECT state,attempts,diagnostics FROM syncup.conflict_checks WHERE card_id=%s',
                             (identifier,)).fetchone()

    def ready(self, count=1):
        for i in range(count):
            self.publish_card('old'+str(i), SECRET + ' old ' + str(i))
        self.publish_card('todo', 'Synthetic task', tag='todo')
        self.settle_checks()
        self.publish_card('new', SECRET + ' new')

    def test_diagnostic_success_no_plaintext_and_survives_reconnect(self):
        self.ready()
        calls = []
        class Model:
            model = SECRET
            def decide(self, text, questions):
                calls.append(questions)
                return {q['name']: dict(type='choice', choice='무관', confidence=.9) for q in questions}
        with decisions_model(Model()):
            self.run_due_checks()
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
        self.run_due_checks()
        self.assertEqual(self.saved()['diagnostics'], d)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(self.saved(user='Bob', team='B'))
        with self.team_db('Bob', 'B') as c:
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
        with decisions_model(Model()):
            self.run_due_checks()
            self.run_due_checks()
        d = self.saved()['diagnostics']
        self.assertEqual((d['candidate_count'], d['outcome'], len(calls)), (1, 'needs-review', 2))
        item = self.board_item('new')
        self.assertEqual(item['conflictCheckProgress'], dict(total=2, completed=1, skipped=0))
        self.assertIsNone(d['checked_count'])
        self.assertNotIn(SECRET, json.dumps(d))

    def test_diagnostic_transport_limit_manual_reset_and_latest_only(self):
        self.ready()
        self.api.conflict_engine = lambda req: dict(ok=False, retryable=True, failureReason='communication', error=SECRET)
        for attempt in range(1, 4):
            self.run_due_checks()
            d = self.saved()['diagnostics']
            self.assertEqual(d['attempt'], attempt)
            self.assertEqual(d['outcome'], 'retry-pending' if attempt < 3 else 'retry-exhausted')
            self.assertIsNone(d['checked_count'])
            self.assertNotIn(SECRET, json.dumps(d))
            self.make_check_due('new')
        self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
        self.assertEqual(self.saved()['diagnostics'], {})
        self.api.conflict_engine = lambda req: dict(ok=True, checkStatus='complete', conflicts=[])
        self.run_due_checks()
        d = self.saved()['diagnostics']
        self.assertEqual((d['attempt'], d['outcome']), (1, 'check-failed'))
        self.assertIsNone(d['checked_count'])  # Custom engine did not provide comparison results.
        self.assertIsNone(d['policy_sha256'])

    def test_diagnostic_exception_body_and_unknown_reason_excluded(self):
        self.ready()
        def failed(req):
            raise ValueError(SECRET)
        self.api.conflict_engine = failed
        with self.assertLogs('syncup', level='WARNING') as logs:
            self.run_due_checks()
        self.assertNotIn(SECRET, ''.join(logs.output))
        self.assertEqual(self.saved()['diagnostics']['outcome'], 'check-failed')
        self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
        self.api.conflict_engine = lambda req: dict(ok=False, failureReason=SECRET, error=SECRET)
        self.run_due_checks()
        self.assertNotIn(SECRET, json.dumps(self.saved()['diagnostics']))

    def test_diagnostic_interrupted_attempt_is_durable(self):
        self.ready()
        def interrupted(req):
            self.assertEqual(self.saved()['diagnostics']['outcome'], 'running')
            raise KeyboardInterrupt()
        self.api.conflict_engine = interrupted
        with self.assertRaises(KeyboardInterrupt):
            self.run_due_checks()
        self.make_check_due('new')
        self.api.conflict_engine = checked
        self.run_due_checks()
        row = self.saved()
        self.assertEqual((row['state'], row['diagnostics']['outcome']), ('complete', 'complete'))
        self.assertEqual(row['diagnostics']['checked_count'], 1)

    def test_diagnostic_late_worker_cannot_replace_new_lease(self):
        self.assert_late_worker_loses_lease()
        self.assertEqual(self.saved('late')['diagnostics'], {})  # Manual retry cleared the old attempt.

    def test_diagnostic_legacy_upgrade_twice_preserves_records(self):
        self.ready()
        self.reapply_upgrade('diagnostics')
        self.assertEqual(self.saved()['diagnostics'], {})


def load_tests(loader, tests, pattern):
    return own_tests(MetadataContract, DiagnosticPersistence)


if __name__ == '__main__':
    unittest.main(verbosity=2)
