"""On-device privacy gate: format rules on every route, semantic decisions, the legacy collector.

Synthetic inputs only, every external request intercepted, sockets blocked. The scripted classifier stands in for the
local model so the routing is deterministic; holds and rechecks are in check_privacy_holds.py, the Ollama client in
check_privacy_model_client.py, and real-model quality in check_local_privacy_model.py.
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import json
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

from batch_classification import classify_queued
from candidate_review import list_candidates, update_candidate
import standalone_classifier
from collection_settings import configure
from collection_status import collection_status
from local_fixtures import (FAKE_AUTH, HEALTH, HIDDEN, KEEP, MIXED, SECRETS, PrivacyFixture, Scripted, leaked, offline,
                            private_db, responses, strings)
from local_privacy import Gate
from local_rpc import dispatch
from privacy_rules import apply_rules, secret_values
from storage import connect
import turn_intake


class RulesOnEveryRoute(PrivacyFixture):
    """Format rules must hold on every way text reaches the external AI."""

    def route(self, name, text):
        if name in ('append', 'paste', 'export'):
            site = dict(append='chatgpt', paste='manual', export='chatgpt-export')[name]
            turn_intake.append(self.pipeline, [self.message('m1', text, site)], True)
        elif name == 'assistant':
            turn_intake.append(self.pipeline, [self.message('q', '어떻게 할까?'), self.message('a', text, role='assistant')], True)
        elif name == 'recovery':
            turn_intake.append(self.pipeline, [self.message('m1', 'SQLite 검토 중')])
            issue = turn_intake.append(self.pipeline, [self.message('m1', '바뀐 원문')])['intakeIssues'][0]['id']
            dispatch(self.pipeline, 'intake.retry', dict(id=issue, teamId='a', message=self.message('fix', text, 'manual')))
        elif name in ('codex_job', 'claude_job'):
            source = 'codex' if name == 'codex_job' else 'claude-code'
            with connect(self.db) as c:
                c.execute("INSERT INTO jobs VALUES(?,?,'new','')", ('local-1', json.dumps([dict(n=1, role='user', text=text, source=source, at=time.time())])))
            turn_intake.capture_scanned_jobs(self.pipeline)
        elif name == 'retry':
            turn_intake.append(self.pipeline, [self.message('m1', text)], True)
            with patch('urllib.request.urlopen', side_effect=urllib.error.URLError(OSError('down'))) as first:
                classify_queued(self.pipeline)
            self.requests.append(dict(url='first', body=json.loads(first.call_args[0][0].data.decode())))
            job = collection_status(self.pipeline)['failedJobs'][0]['id']
            dispatch(self.pipeline, 'jobs.retry', dict(id=job, teamId='a'))
        elif name == 'context':
            turn_intake.append(self.pipeline, [self.message('m1', text)], True)
            self.run_offline()
            turn_intake.append(self.pipeline, [self.message('m2', 'PostgreSQL도 검토했다.')], True)
        elif name == 'stored_job':
            # Saved before any masking existed: raw text sits in job_context.
            turn_intake.append(self.pipeline, [self.message('seed', 'SQLite 검토 중')], True)
            with connect(self.db) as c:
                job, = c.execute("SELECT job FROM job_context").fetchone()
                messages = json.loads(c.execute('SELECT messages FROM job_context WHERE job=?', (job,)).fetchone()[0])
                messages[0]['text'] = text
                c.execute('UPDATE job_context SET messages=? WHERE job=?', (json.dumps(messages, ensure_ascii=False), job))
        self.run_offline()

    def test_secrets_and_contacts_never_reach_the_request(self):
        routes = ('append', 'assistant', 'paste', 'export', 'recovery', 'codex_job', 'claude_job', 'retry', 'context', 'stored_job')
        for route in routes:
            for case, secret_line in SECRETS.items():
                with self.subTest(route=route, case=case):
                    self.fresh()
                    self.route(route, KEEP + '\n' + secret_line)
                    self.assertTrue(self.requests, 'no external request captured; cannot claim masking passed')
                    self.assertFalse(leaked(self.requests, HIDDEN[case]))
                    self.assertTrue(any('PRIVACY_CANARY_KEEP' in s for r in self.requests for s in strings(r['body'])))

    def test_ordinary_identifiers_survive(self):
        text = KEEP + '\ncommit abcdef123456 port 8080 sha 3a54050102c8a38df1730c89fff7b2c95a9b841e'
        self.route('append', text)
        self.assertTrue(any(text in s for r in self.requests for s in strings(r['body'])))


class KoreanCredentialRule(unittest.TestCase):
    """Policy v2: digits after Korean credential words are masked; counts and units are not."""

    def test_values_masked_units_kept(self):
        masked = {'label은 work. 내 카드 비밀번호 앞자리는 4321이야': '4321', '카드 번호 1234-5678-9012-3456 로 결제했어': '9012',
                  '인증번호 482913 입력해 줘': '482913'}
        for text, value in masked.items():
            with self.subTest(text=text):
                out, rules = apply_rules(text)
                self.assertNotIn(value, out)
                self.assertIn('korean_credential', rules)
                self.assertTrue(secret_values(text), 'outbound check also recognises it')
        for text in ('비밀번호는 최소 128자 이상으로 하자', '비밀번호 재설정 메일은 24시간 유효', '암호화 키 길이는 256비트',
                     'OTP 6자리 입력 화면 만들자', '비밀번호 정책은 2026년 1월부터 적용',
                     # work tokens near credential words stay readable and do not trip the outbound check
                     '비밀번호 해시는 PBKDF2-SHA256으로 하자', 'PIN 관련 이슈 https://github.com/x/y/issues/1234 확인',
                     '보안코드 검사 로직은 utils/cvc.ts:120 에 있다', 'PIN 입력창 width=320px로 하자',
                     '비밀번호는 내일 v2.0.123 배포 후에 바꾸자', '- 기존 세부 주제: OTP 재전송, v1.0.100 배포'):
            with self.subTest(text=text):
                self.assertEqual(apply_rules(text), (text, []))
                self.assertEqual(secret_values(text), [])

    def test_long_unspaced_input_stays_fast(self):
        started = time.monotonic()
        apply_rules('OTP:abc;' * 2500)
        secret_values('OTP:abc;' * 2500)
        self.assertLess(time.monotonic() - started, 1.0)


class SemanticGate(PrivacyFixture):
    def test_personal_message_is_kept_local_and_never_sent(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        turn_intake.append(self.pipeline, [self.message('p', HEALTH)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.count("SELECT count(*) FROM jobs WHERE state='done' AND detail LIKE '개인 내용%'"), 1)
        self.assertEqual(self.count("SELECT count(*) FROM intake WHERE message LIKE ?", '%허리 통증%'), 1)
        self.assertEqual(collection_status(self.pipeline)['counts']['privacyExcluded'], 1)
        self.assertEqual(self.count('SELECT count(*) FROM outbox'), 0)

    def test_mixed_sentence_sends_only_the_work_part_and_keeps_evidence(self):
        self.pipeline.privacy = Gate(Scripted({MIXED: dict(label='mixed', personal=['병원 때문에'])}))
        card = lambda body: responses(dict(cards=[dict(msg=1, relevance='related', tag='todo', subtopic='작업·결과물',
            sentence='발표자료는 금요일에 공유할게', content='발표자료 금요일 공유', topic_key='발표자료', confidence=.9, owner='테스트')]))
        turn_intake.append(self.pipeline, [self.message('mix', MIXED)], True)
        self.run_offline(card)
        self.assertEqual(len(self.requests), 1)
        # The static system prompt mentions 병원 as an example category, so check the user input only.
        self.assertNotIn('병원', self.requests[0]['body']['input'])
        self.assertIn('[개인사정] 발표자료는 금요일에 공유할게', self.requests[0]['body']['input'])
        cards = list_candidates(self.pipeline)
        self.assertEqual(cards[0]['evidence']['messageId'], 'mix')
        self.assertNotIn('병원', json.dumps(cards, ensure_ascii=False))
        # Editing back to the sanitized quote stays grounded; approval carries no personal reason.
        update_candidate(self.pipeline, cards[0]['id'], dict(sentence='[개인사정] 발표자료는 금요일에 공유할게'))
        dispatch(self.pipeline, 'candidates.approve', dict(ids=[cards[0]['id']], teamId='a'))
        with connect(self.db) as c:
            payload = c.execute('SELECT payload FROM outbox').fetchone()[0]
        self.assertNotIn('병원', payload)

    def test_work_label_with_personal_words_holds(self):
        text = '수술 일정 때문에 이번 주 리뷰는 빠질게'
        turn_intake.append(self.pipeline, [self.message('w', text)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(dispatch(self.pipeline, 'privacy.list', {})['items'][0]['reason'], 'rule_model_conflict')

    def test_project_topic_words_are_not_personal_but_other_words_still_hold(self):
        configure(self.pipeline, dict(projectTopic='병원 예약 서비스'))
        turn_intake.append(self.pipeline, [self.message('d', '병원 예약 시스템 API는 REST로 설계하자')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 1)
        turn_intake.append(self.pipeline, [self.message('s', '수술 일정 때문에 이번 주 리뷰는 빠질게')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(collection_status(self.pipeline)['counts']['privacyHeld'], 1)

    def test_earlier_personal_context_is_not_attached(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        turn_intake.append(self.pipeline, [self.message('p', HEALTH)], True)
        self.run_offline()
        turn_intake.append(self.pipeline, [self.message('w', 'API 명세는 내일 올릴게')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(leaked(self.requests, '허리 통증'))

    def test_privacy_list_reports_excluded_messages_per_message_and_team(self):
        configure(self.pipeline, dict(turnsPerBatch=3))
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH]),
                                               MIXED: dict(label='mixed', personal=['병원 때문에'])}))
        turn_intake.append(self.pipeline, [self.message('w', 'API 명세는 내일 올릴게'), self.message('p', HEALTH), self.message('m', MIXED)], True)
        self.run_offline()
        listed = dispatch(self.pipeline, 'privacy.list', {})
        # Partial exclusion inside an allowed batch is listed; the redacted mixed message is not.
        self.assertEqual((listed['teamId'], listed['items'], listed['excludedCount']), ('a', [], 1))
        entry = listed['excluded'][0]
        self.assertEqual((entry['messageId'], entry['reason'], entry['role'], entry['site']), ('p', 'personal', 'user', 'chatgpt'))
        self.assertEqual(collection_status(self.pipeline)['counts']['privacyExcluded'], 0, 'whole-batch count keeps its meaning')
        with connect(self.db) as c:
            c.execute("UPDATE job_context SET team_id='b'")
        self.assertEqual(dispatch(self.pipeline, 'privacy.list', {})['excluded'], [])


class LegacyCollector(unittest.TestCase):
    """The older collector (Rust excerpts -> OpenAI) also passes the gate."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = private_db(temp.name, bound=False)

    def job(self, identifier, state, evidence):
        with connect(self.db) as c:
            c.execute('INSERT INTO jobs VALUES(?,?,?,?)', (identifier, json.dumps(evidence, ensure_ascii=False), state, ''))
            if state == 'draft':
                c.execute("INSERT INTO cards VALUES(?,?,'decision',1,NULL,NULL,NULL,'drafting')", (identifier + '-decision', identifier))

    def test_draft_and_classify_send_sanitized_or_nothing(self):
        gate = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        self.job('secret', 'draft', [dict(n=1, role='user', text=KEEP + '\n' + SECRETS['openai_project'])])
        self.job('health', 'new', [dict(n=1, role='user', text=HEALTH)])
        requests = []
        draft = lambda body: responses(dict(cards=[dict(kind='decision', text='DB = SQLite', n=1, quote='SQLite 사용을 결정했다.')]))
        with patch.dict('os.environ', OPENAI_API_KEY=FAKE_AUTH), offline(requests, draft):
            standalone_classifier.process(self.db, gate=gate)
        self.assertEqual([r['url'].rsplit('/', 1)[-1] for r in requests], ['responses'])
        self.assertFalse(leaked(requests, 'SyntheticOnlyAbCdEf' * 3))
        self.assertFalse(leaked(requests, '허리 통증'))
        with connect(self.db) as c:
            self.assertEqual(dict(c.execute('SELECT id,state FROM jobs')), dict(secret='done', health='done'))

    def test_legacy_hold_when_model_missing(self):
        self.job('n', 'new', [dict(n=1, role='user', text='API 명세는 내일 올릴게')])
        requests = []
        with patch.dict('os.environ', OPENAI_API_KEY=FAKE_AUTH), offline(requests):
            standalone_classifier.process(self.db, gate=Gate(Scripted(mode='down')))
        self.assertEqual(requests, [])
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT state FROM jobs').fetchone()[0], 'new')


if __name__ == '__main__':
    unittest.main()
