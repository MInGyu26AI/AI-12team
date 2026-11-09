"""Fail-closed privacy holds: model failures, unsure answers, user exclusion, rechecks and the outbound guard.

Synthetic inputs only; every external request is intercepted.
"""
import io
import json
import logging
import unittest
from unittest.mock import patch
import urllib.error

from batch_classification import classify_queued
from collection_settings import configure
from collection_status import collection_status
import local_privacy
from local_fixtures import HEALTH, KEEP, SECRETS, TOKEN, Client, PrivacyFixture, Scripted, leaked, offline, strings
from local_privacy import Gate
from local_rpc import dispatch
from storage import connect
import turn_intake
from turn_pipeline import TurnPipeline


class FailClosed(PrivacyFixture):
    def test_every_model_failure_holds_and_survives_restart(self):
        for mode in ('down', 'timeout', 'error', 'garbage'):
            with self.subTest(mode=mode):
                self.fresh()
                self.pipeline.privacy = Gate(Scripted(mode=mode))
                turn_intake.append(self.pipeline, [self.message('m', 'API 명세는 내일 올릴게')], True)
                self.run_offline()
                self.assertEqual(self.requests, [])
                counts = collection_status(self.pipeline)['counts']
                self.assertEqual((counts['privacyHeld'], counts['classificationPending']), (1, 0))
                restarted = TurnPipeline(self.db, Client())
                restarted.llm_factory, restarted.decider_factory = self.pipeline.llm_factory, (lambda: None)
                restarted.privacy = Gate(Scripted(mode=mode))
                with offline(self.requests):
                    classify_queued(restarted)
                self.assertEqual(self.requests, [])

    def test_unsure_holds_until_user_excludes_only_that_message(self):
        doubt = '그 사람 얘기는 나중에 따로 하자'
        configure(self.pipeline, dict(turnsPerBatch=2))
        self.pipeline.privacy = Gate(Scripted({doubt: dict(label='unsure', personal=[])}))
        turn_intake.append(self.pipeline, [self.message('a', 'API 명세는 내일 올릴게'), self.message('b', doubt)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        item = dispatch(self.pipeline, 'privacy.list', {})['items'][0]
        self.assertEqual([m['decision'] for m in item['messages']], ['allow', 'hold'])
        # Restart: still held, still nothing sent.
        restarted = TurnPipeline(self.db, Client())
        restarted.llm_factory, restarted.decider_factory, restarted.privacy = self.pipeline.llm_factory, (lambda: None), self.pipeline.privacy
        with offline(self.requests):
            classify_queued(restarted)
        self.assertEqual(self.requests, [])
        with self.assertRaises(ValueError):
            dispatch(restarted, 'privacy.exclude', dict(id=item['id'], teamId='b', messageId='b'))
        dispatch(restarted, 'privacy.exclude', dict(id=item['id'], teamId='a', messageId='b'))
        with offline(self.requests):
            classify_queued(restarted)
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(leaked(self.requests, doubt))
        self.assertTrue(any('API 명세는 내일 올릴게' in s for s in strings(self.requests[0]['body'])))
        listed = dispatch(restarted, 'privacy.list', {})
        self.assertEqual((listed['items'], [(e['messageId'], e['reason']) for e in listed['excluded']]), ([], [('b', 'user_excluded')]))

    def test_user_excluded_message_is_not_sent_as_next_batch_context(self):
        # Held while the model was down, so no cached answer: once the model is back it would call the message work.
        doubt = '그 사람 얘기는 나중에 따로 하자'
        gate = Gate(Scripted(mode='down'))
        self.pipeline.privacy = gate
        configure(self.pipeline, dict(turnsPerBatch=2))
        turn_intake.append(self.pipeline, [self.message('a', 'API 명세는 내일 올릴게'), self.message('b', doubt)], True)
        self.run_offline()
        held = dispatch(self.pipeline, 'privacy.list', {})['items'][0]['id']
        dispatch(self.pipeline, 'privacy.exclude', dict(id=held, teamId='a', messageId='b'))
        gate.classifier.mode = None
        self.run_offline()
        turn_intake.append(self.pipeline, [self.message('c', 'PostgreSQL도 검토했다.'), self.message('d', '배포는 금요일에 하자')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 2)
        self.assertFalse(leaked(self.requests, doubt))
        self.assertTrue(any('PostgreSQL도 검토했다.' in s for s in strings(self.requests[1]['body'])))

    def test_blocked_fragment_hold_can_be_excluded_by_the_user(self):
        # The excluded message and the allowed one share a phrase, so the outbound check refuses the request.
        personal = '허리 통증으로 병원 가야 해서, 회의록 정리는 내일 할게'
        work = '회의록 정리는 내일 할게. API 명세도 같이 올릴게'
        self.pipeline.privacy = Gate(Scripted({personal: dict(label='personal', personal=[personal])}))
        configure(self.pipeline, dict(turnsPerBatch=2))
        turn_intake.append(self.pipeline, [self.message('p', personal), self.message('w', work)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        item = dispatch(self.pipeline, 'privacy.list', {})['items'][0]
        self.assertEqual(item['reason'], 'blocked_fragment')
        self.assertEqual({m['id']: m['decision'] for m in item['messages']}, dict(p='exclude', w='hold'))
        dispatch(self.pipeline, 'privacy.exclude', dict(id=item['id'], teamId='a'))
        self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(dispatch(self.pipeline, 'privacy.list', {})['items'], [])
        self.assertEqual(collection_status(self.pipeline)['counts']['privacyExcluded'], 1)

    def test_recheck_request_stays_held_until_the_worker_decides(self):
        gate = Gate(Scripted(mode='down'))
        self.pipeline.privacy = gate
        turn_intake.append(self.pipeline, [self.message('m', 'API 명세는 내일 올릴게')], True)
        self.run_offline()
        job = dispatch(self.pipeline, 'privacy.list', {})['items'][0]['id']
        self.assertEqual(dispatch(self.pipeline, 'privacy.recheck', dict(id=job, teamId='a')), dict(queued=True))
        # queued is not done: still listed and counted as held, nothing sent.
        listed = dispatch(self.pipeline, 'privacy.list', {})['items']
        self.assertEqual((listed[0]['reason'], collection_status(self.pipeline)['counts']['privacyHeld']), ('recheck_requested', 1))
        self.assertEqual(self.requests, [])
        gate.classifier.mode = None
        self.run_offline()
        self.assertEqual((dispatch(self.pipeline, 'privacy.list', {})['items'], len(self.requests)), ([], 1))

    def test_runtime_hold_rechecks_by_itself_once_the_model_is_back(self):
        gate = Gate(Scripted(mode='down'))
        self.pipeline.privacy = gate
        turn_intake.append(self.pipeline, [self.message('m', 'API 명세는 내일 올릴게')], True)
        self.run_offline()
        gate.classifier.mode = None
        self.run_offline()
        self.assertEqual(self.requests, [], 'recheck must wait, not hammer the runtime')
        with connect(self.db) as c:
            c.execute('UPDATE privacy_jobs SET decided=decided-?', (local_privacy.RECHECK_SECONDS + 1,))
        self.run_offline()
        self.assertEqual(len(self.requests), 1)

    def test_outbound_guard_stops_a_payload_that_slipped_past(self):
        real = self.pipeline.privacy.review_job
        def leaky(*args, **kwargs):
            review = real(*args, **kwargs)
            review.messages[0]['text'] = 'Authorization: Bearer ' + TOKEN  # simulated gate bug
            return review
        self.pipeline.privacy.review_job = leaky
        turn_intake.append(self.pipeline, [self.message('m', 'API 명세는 내일 올릴게')], True)
        # Inject after the classifier's own masking too, so the final guard is actually exercised.
        with patch('ai.syncup_ai.classify.build_user_prompt', return_value=('Authorization: Bearer '+TOKEN, [])):
            self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.count("SELECT count(*) FROM privacy_jobs WHERE decision='hold' AND reason='secret_in_payload'"), 1)

    def test_nothing_sensitive_in_logs_details_or_errors(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logging.getLogger('syncup').addHandler(handler)
        self.addCleanup(logging.getLogger('syncup').removeHandler, handler)
        turn_intake.append(self.pipeline, [self.message('p', HEALTH), self.message('s', KEEP + '\n' + SECRETS['bearer_header'])], True)
        with patch('urllib.request.urlopen', side_effect=urllib.error.URLError(OSError('down'))), \
             patch('sys.stderr', new_callable=io.StringIO) as err:
            classify_queued(self.pipeline)
        with connect(self.db) as c:
            # Originals stay in intake/job_context by design; the gate's own records hold no raw secret or personal text.
            gate_rows = json.dumps([list(r) for t in ('privacy_jobs', 'privacy_results') for r in c.execute(f'SELECT * FROM {t}')], ensure_ascii=False)
            details = json.dumps([list(r) for r in c.execute('SELECT detail FROM jobs')], ensure_ascii=False)
        status = json.dumps(collection_status(self.pipeline), ensure_ascii=False)
        for text in (stream.getvalue(), err.getvalue(), status, gate_rows, details):
            self.assertNotIn('허리 통증', text)
            self.assertNotIn(TOKEN, text)
        self.assertIn('[액세스토큰]', gate_rows)


if __name__ == '__main__':
    unittest.main()
