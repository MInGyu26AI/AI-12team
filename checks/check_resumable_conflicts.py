"""Real PostgreSQL, HTTP and process restart; synthetic Decisions service, no external AI."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import json
import os
import re
import time
import unittest
from unittest.mock import patch
import psycopg

from check_teams import TeamIsolation, own_tests, request, team_api_process
from check_team_integration import TeamIntegration, answers, checked, stub_model
from conflict_checks import process_checks
from conflict_scheduler import schedule
from team_access import AccessError


class ResumableChecks(TeamIsolation):
    publish_card = TeamIntegration.publish_card

    def seed(self, count):
        for i in range(count):
            self.publish_card(f'old-{i:03}', f'OLD_{i:03} 서버 결정', topic='다른 주제' if i == count-1 else 'DB')
        self.settle_checks()
        self.publish_card('new', 'NEW_TARGET 서버 결정')

    def job(self):
        with self.team_db() as c:
            return c.execute("SELECT * FROM syncup.conflict_checks WHERE card_id='new'").fetchone()

    def wait_complete(self, timeout=20):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            if self.job()['state'] == 'complete':
                return
            time.sleep(.05)
        self.fail('durable worker did not finish without additional API requests')

    def test_over_thirty_continues_without_api_polling_and_preserves_pairs(self):
        self.seed(65)
        seen = []
        def engine(req):
            old = req['existing'][0]
            seen.append(old['id'])
            alerts = []
            if old['id'] == 'old-064':
                alerts = [dict(id='last-pair', cardA=old, cardB=req['newCards'][0],
                               judgement='충돌', reason='합성 충돌', topic_key='DB')]
            return checked(req, alerts)
        self.api.conflict_engine = engine
        self.run_due_checks()
        self.assertEqual((self.job()['state'], self.job()['progress']['cursor']), ('pending', 30))
        item = self.board_item('new')
        self.assertEqual(item['conflictCheckProgress'], dict(total=65, completed=30, skipped=0))
        self.api.disable_checks = False
        schedule(self.api, self.tokens['Dana'], self.teams['A'])
        self.wait_complete()
        self.assertEqual(len(seen), 65)
        self.assertEqual(len(set(seen)), 65)
        self.assertEqual(seen[-1], 'old-064')
        self.assertEqual(len(self.team_request('GET', 'conflicts')[1]['conflicts']), 1)
        self.assertEqual(self.team_request('GET', 'board', user='Bob')[0], 403)
        with self.team_db('Bob', 'B') as c:
            self.assertIsNone(c.execute("SELECT progress FROM syncup.conflict_checks WHERE card_id='new'").fetchone())

    def test_failed_pair_resumes_only_remaining_and_partial_alert_is_visible(self):
        self.seed(35)
        calls = []
        blocked = [True]
        def engine(req):
            old = req['existing'][0]
            calls.append(old['id'])
            if len(calls) == 8 and blocked[0]:
                return dict(ok=False, failureReason='low-confidence')
            return checked(req, [dict(id='pair-'+old['id'], cardA=old, cardB=req['newCards'][0],
                                     judgement='충돌', reason='합성 충돌', topic_key='DB')])
        self.api.conflict_engine = engine
        self.run_due_checks()
        self.assertEqual(self.job()['progress']['cursor'], 7)
        self.assertEqual(self.job()['state'], 'failed')
        self.assertEqual(len(self.team_request('GET', 'conflicts')[1]['conflicts']), 7)
        self.run_due_checks()
        self.assertEqual(len(calls), 8)  # uncertainty is not retried automatically
        self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
        blocked[0] = False
        self.run_due_checks()
        self.assertEqual(self.job()['state'], 'complete')
        self.assertEqual(len(calls), 36)
        self.assertEqual(len(set(calls)), 35)
        self.assertEqual(len(self.team_request('GET', 'conflicts')[1]['conflicts']), 35)

    def test_review_included_inactive_skipped_and_revoked_access_stops(self):
        self.seed(35)
        with self.team_db() as c:
            c.execute("UPDATE syncup.record_states SET state='review' WHERE card_id='old-034'")
        self.api.conflict_engine = checked
        self.run_due_checks()
        remaining = self.job()['progress']['ids'][30:]
        with self.team_db() as c:
            c.execute("UPDATE syncup.record_states SET state='superseded' WHERE card_id=%s", (remaining[0],))
        self.admin('member', '--user', self.users['Dana'], '--team', self.teams['A'], '--revoke')
        with self.assertRaises(AccessError):
            self.run_due_checks()
        self.admin('member', '--user', self.users['Dana'], '--team', self.teams['A'])
        self.run_due_checks()
        progress = self.job()['progress']
        self.assertEqual((len(progress['ids']), progress['cursor'], progress['skipped']), (35,35,1))

    def test_policy_change_invalidates_completed_checkpoint(self):
        self.seed(35)
        seen = []
        def engine(req):
            seen.append(req['existing'][0]['id'])
            return checked(req)
        self.api.conflict_engine = engine
        self.run_due_checks()
        with patch('conflict_checks.current_policy', return_value='changed-policy'):
            self.run_due_checks()
        self.assertEqual(self.job()['progress']['cursor'], 30)
        self.assertEqual(len(seen), 60)
        self.assertEqual(seen[:30], seen[30:])

    def test_checkpoint_migration_is_idempotent_and_preserves_approvals(self):
        self.seed(1)
        self.reapply_upgrade('progress')
        self.assertEqual(self.job()['progress'], {})

    def test_scheduler_retries_transient_db_failure_without_new_request(self):
        self.seed(1)
        self.api.conflict_engine = checked
        self.api.disable_checks = False
        calls = []
        def temporarily_down(*args):
            calls.append(1)
            if len(calls) == 1:
                raise psycopg.OperationalError('synthetic temporary connection outage')
            return process_checks(*args)
        with patch('conflict_scheduler.process_checks', side_effect=temporarily_down):
            with self.assertLogs('syncup', level='WARNING'):
                schedule(self.api, self.tokens['Dana'], self.teams['A'])
                self.wait_complete()
        self.assertGreaterEqual(len(calls), 2)

    def test_actual_api_process_restart_uses_committed_checkpoint(self):
        self.seed(35)
        calls = []
        def respond(path, raw):
            body = json.loads(raw)
            calls.append(re.search(r'e1:.*OLD_(\d+)', body['input']).group(1))
            time.sleep(.06)
            return 200, answers(body, '무관')
        model = self.enterContext(stub_model(respond))
        env = {k: v for k, v in os.environ.items() if not k.startswith(('AI_', 'OPENAI_', 'SYNCUP_'))}
        env.update(SYNCUP_DATABASE_URL=self.api_dsn, AI_BASE_URL=model, AI_API_KEY='synthetic',
                   AI_MODEL='synthetic-chat', AI_DECISIONS_MODEL='synthetic-decisions')
        board = '/teams/'+self.teams['A']+'/board'
        with team_api_process(env) as api:
            # Any successful team request starts that team's worker.
            self.assertEqual(request(api, 'GET', board, self.tokens['Dana'])[0], 200)
            end = time.monotonic()+15
            while self.job()['progress'].get('cursor', 0) < 7 and time.monotonic() < end:
                time.sleep(.02)
            api.process.kill()
            api.process.wait(timeout=5)
        progress = self.job()['progress']
        self.assertGreaterEqual(progress['cursor'], 7)
        completed = {x[-3:] for x in progress['ids'][:progress['cursor']]}
        time.sleep(.15)  # allow the killed process's in-flight HTTP response to drain
        restart_index = len(calls)
        # Advance only the crash lease (conflict_checks.LEASE, 3 minutes) to keep the test bounded.
        self.make_check_due('new')
        with team_api_process(env) as api:
            self.assertEqual(request(api, 'GET', board, self.tokens['Dana'])[0], 200)
            self.wait_complete()
        self.assertFalse(completed.intersection(calls[restart_index:]))
        self.assertEqual(set(calls), {f'{i:03}' for i in range(35)})
        self.assertEqual(self.job()['progress']['cursor'], 35)


def load_tests(loader, tests, pattern):
    return own_tests(ResumableChecks)


if __name__ == '__main__':
    unittest.main(verbosity=2)
