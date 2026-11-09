"""On-device privacy gate: synthetic inputs only, every external request intercepted, sockets blocked.

The scripted classifier stands in for the local model so the routing is deterministic. Real-model
quality is measured separately by check_local_privacy_model.py.
"""
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import http.server
import io
import json
import logging
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error

import collector
import local_privacy
from ai.syncup_ai import llm
from integration import Pipeline
from local_privacy import Gate, ModelError, ModelOutputError, ModelTimeout, ModelUnavailable, OllamaClassifier
from storage import connect, initialize

KEEP = 'SQLite 사용을 결정했다. PRIVACY_CANARY_KEEP 날짜 2026-11-08'
FAKE_AUTH = 'synthetic-transport-key-not-a-real-credential'
TOKEN = 'SyntheticToken_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'[:43]
SECRETS = {
    'openai_project': 'OPENAI_API_KEY=sk-proj-' + 'SyntheticOnlyAbCdEf' * 7,
    'openai_legacy': 'OPENAI_API_KEY=sk-' + 'SyntheticOnlyAbCd' * 3,
    'github_classic': 'GITHUB_TOKEN=ghp_' + 'SyntheticOnlyAbCdEf' * 2,
    'github_fine_grained': 'GITHUB_TOKEN=github_pat_' + 'SyntheticOnlyAbCdEf' * 4,
    'bearer_header': 'Authorization: Bearer ' + TOKEN,
    'bearer_lowercase': 'authorization: bearer ' + TOKEN,
    'json_token': '{"token": "' + TOKEN + '"}',
    'access_token_assignment': 'access_token=' + TOKEN,
    'json_access_token': '{"access_token": "' + TOKEN + '"}',
    'bare_token': TOKEN,
    'url_password': 'postgres://app:Synthetic-Pass-0042@db.invalid/syncup',
    'email_control': '이메일 synthetic.person@example.invalid',
    'phone_control': '전화 010-0000-0000',
}
VALUES = {'url_password': 'Synthetic-Pass-0042', 'email_control': 'synthetic.person@example.invalid',
          'phone_control': '010-0000-0000'}
HEALTH = '요즘 허리 통증 때문에 병원 다니고 있어서 너무 힘들다'
MIXED = '병원 때문에 발표자료는 금요일에 공유할게'


class WorkOnly:
    """Test classifier: every input is work. Lets older suites keep their deterministic AI."""
    def identity(self): return 'test:work-only'
    def classify(self, text): return dict(label='work', personal=[])


def work_gate():
    return Gate(WorkOnly())


class Scripted:
    """Local-model stand-in. Labels by substring; failure modes raise what the real client raises."""
    def __init__(self, labels=None, mode=None):
        self.labels, self.mode, self.calls = labels or {}, mode, []
    def identity(self):
        if self.mode == 'down':
            raise ModelUnavailable('runtime down')
        return 'test:scripted'
    def classify(self, text):
        self.calls.append(text)
        if self.mode in ('timeout', 'error', 'garbage'):
            raise {'timeout': ModelTimeout, 'error': ModelError, 'garbage': ModelOutputError}[self.mode]('fault')
        for needle, label in self.labels.items():
            if needle in text:
                return label
        return dict(label='work', personal=[])


class Client:
    api_url = 'https://example.test/'
    user_id = 'user'
    def me(self): return dict(user_id='user', name='테스트', teams=[dict(id='a', name='팀 A')])


@contextmanager
def offline(requests, reply=None, loopback=False):
    """Capture every urlopen body; refuse any other socket. Nothing leaves the machine."""
    real_connect, real_resolve = socket.socket.connect, socket.getaddrinfo
    def connect(sock, address):
        if loopback and address[0] in ('127.0.0.1', '::1'):
            return real_connect(sock, address)
        raise OSError('network blocked in test')
    def resolve(host, *args, **kwargs):
        if loopback and host in ('127.0.0.1', '::1'):
            return real_resolve(host, *args, **kwargs)
        raise OSError('dns blocked in test')
    def capture(request, timeout=None):
        body = json.loads(request.data.decode())
        requests.append(dict(url=request.full_url, body=body))
        if not request.full_url.startswith('https://api.openai.com/v1/'):
            raise AssertionError('unexpected external URL')
        return io.BytesIO(json.dumps(reply(body) if reply else empty_reply(body)).encode())
    with ExitStack() as stack:
        stack.enter_context(patch('urllib.request.urlopen', side_effect=capture))
        stack.enter_context(patch('socket.socket.connect', connect))
        stack.enter_context(patch('socket.getaddrinfo', resolve))
        yield


def responses(payload):
    return dict(output=[dict(content=[dict(type='output_text', text=json.dumps(payload, ensure_ascii=False))])])


def empty_reply(body):
    return responses(dict(cards=[]))


def strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    return []


def leaked(requests, value):
    return any(value in s or (len(value) > 12 and value[-12:] in s) for r in requests for s in strings(r['body']))


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'private.sqlite'; initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (self.temp.name, time.time() - 10, time.time() + 600))
            c.execute("INSERT INTO sharing VALUES(1,?,'user','a')", (Client.api_url,))
        self.pipeline = Pipeline(self.db, Client())
        self.pipeline.llm_factory = lambda: llm.OpenAIResponses(FAKE_AUTH)
        self.pipeline.decider_factory = lambda: None
        self.pipeline.privacy = Gate(Scripted())
        self.pipeline.configure(dict(projectTopic='SyncUp', turnsPerBatch=1))
        self.requests = []

    def message(self, identifier, text, site='chatgpt', role='user'):
        return dict(id=identifier, site=site, conversationId='conv', role=role, roleGuessed=False, text=text,
                    collectedAt=datetime.now(timezone.utc).isoformat())

    def run_offline(self, reply=None):
        with offline(self.requests, reply):
            self.pipeline.process()

    def count(self, sql, *args):
        with connect(self.db) as c:
            return c.execute(sql, args).fetchone()[0]


class RulesOnEveryRoute(Base):
    """Format rules must hold on every way text reaches the external AI."""

    def route(self, name, text):
        p = self.pipeline
        if name in ('append', 'paste', 'export'):
            site = dict(append='chatgpt', paste='manual', export='chatgpt-export')[name]
            p.append([self.message('m1', text, site)], True)
        elif name == 'assistant':
            p.append([self.message('q', '어떻게 할까?'), self.message('a', text, role='assistant')], True)
        elif name == 'recovery':
            p.append([self.message('m1', 'SQLite 검토 중')])
            issue = p.append([self.message('m1', '바뀐 원문')])['intakeIssues'][0]['id']
            p.rpc('intake.retry', dict(id=issue, teamId='a', message=self.message('fix', text, 'manual')))
        elif name in ('codex_job', 'claude_job'):
            source = 'codex' if name == 'codex_job' else 'claude-code'
            with connect(self.db) as c:
                c.execute("INSERT INTO jobs VALUES(?,?,'new','')", ('local-1', json.dumps([dict(n=1, role='user', text=text, source=source, at=time.time())])))
            p.capture_local_jobs()
        elif name == 'retry':
            p.append([self.message('m1', text)], True)
            with patch('urllib.request.urlopen', side_effect=urllib.error.URLError(OSError('down'))) as first:
                p.process()
            self.requests.append(dict(url='first', body=json.loads(first.call_args[0][0].data.decode())))
            job = self.pipeline.status()['failedJobs'][0]['id']
            p.rpc('jobs.retry', dict(id=job, teamId='a'))
        elif name == 'context':
            p.append([self.message('m1', text)], True)
            self.run_offline()
            p.append([self.message('m2', 'PostgreSQL도 검토했다.')], True)
        elif name == 'stored_job':
            # Saved before any masking existed: raw text sits in job_context.
            p.append([self.message('seed', 'SQLite 검토 중')], True)
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
                    self.setUp()
                    self.route(route, KEEP + '\n' + secret_line)
                    self.assertTrue(self.requests, 'no external request captured; cannot claim masking passed')
                    value = VALUES.get(case) or secret_line.split('=', 1)[-1].split(' ')[-1].strip('{}"')
                    if case.startswith('json_'):
                        value = TOKEN
                    self.assertFalse(leaked(self.requests, value))
                    self.assertTrue(any('PRIVACY_CANARY_KEEP' in s for r in self.requests for s in strings(r['body'])))
                    self.temp.cleanup()

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
                out, rules = local_privacy.apply_rules(text)
                self.assertNotIn(value, out); self.assertIn('korean_credential', rules)
                self.assertTrue(local_privacy.secret_values(text), 'outbound check also recognises it')
        for text in ('비밀번호는 최소 128자 이상으로 하자', '비밀번호 재설정 메일은 24시간 유효', '암호화 키 길이는 256비트',
                     'OTP 6자리 입력 화면 만들자', '비밀번호 정책은 2026년 1월부터 적용',
                     # work tokens near credential words stay readable and do not trip the outbound check
                     '비밀번호 해시는 PBKDF2-SHA256으로 하자', 'PIN 관련 이슈 https://github.com/x/y/issues/1234 확인',
                     '보안코드 검사 로직은 utils/cvc.ts:120 에 있다', 'PIN 입력창 width=320px로 하자',
                     '비밀번호는 내일 v2.0.123 배포 후에 바꾸자', '- 기존 세부 주제: OTP 재전송, v1.0.100 배포'):
            with self.subTest(text=text):
                self.assertEqual(local_privacy.apply_rules(text), (text, []))
                self.assertEqual(local_privacy.secret_values(text), [])

    def test_long_unspaced_input_stays_fast(self):
        started = time.monotonic()
        local_privacy.apply_rules('OTP:abc;' * 2500); local_privacy.secret_values('OTP:abc;' * 2500)
        self.assertLess(time.monotonic() - started, 1.0)


class SemanticGate(Base):
    def test_personal_message_is_kept_local_and_never_sent(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        self.pipeline.append([self.message('p', HEALTH)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.count("SELECT count(*) FROM jobs WHERE state='done' AND detail LIKE '개인 내용%'"), 1)
        self.assertEqual(self.count("SELECT count(*) FROM intake WHERE message LIKE ?", '%허리 통증%'), 1)
        self.assertEqual(self.pipeline.status()['counts']['privacyExcluded'], 1)
        self.assertEqual(self.count('SELECT count(*) FROM outbox'), 0)

    def test_mixed_sentence_sends_only_the_work_part_and_keeps_evidence(self):
        self.pipeline.privacy = Gate(Scripted({MIXED: dict(label='mixed', personal=['병원 때문에'])}))
        card = lambda body: responses(dict(cards=[dict(msg=1, relevance='related', tag='todo', subtopic='작업·결과물',
            sentence='발표자료는 금요일에 공유할게', content='발표자료 금요일 공유', topic_key='발표자료', confidence=.9, owner='테스트')]))
        self.pipeline.append([self.message('mix', MIXED)], True)
        self.run_offline(card)
        self.assertEqual(len(self.requests), 1)
        # The static system prompt mentions 병원 as an example category, so check the user input only.
        self.assertNotIn('병원', self.requests[0]['body']['input'])
        self.assertIn('[개인사정] 발표자료는 금요일에 공유할게', self.requests[0]['body']['input'])
        cards = self.pipeline.candidates()
        self.assertEqual(cards[0]['evidence']['messageId'], 'mix')
        self.assertNotIn('병원', json.dumps(cards, ensure_ascii=False))
        # Editing back to the sanitized quote stays grounded; approval carries no personal reason.
        self.pipeline.update(cards[0]['id'], dict(sentence='[개인사정] 발표자료는 금요일에 공유할게'))
        self.pipeline.rpc('candidates.approve', dict(ids=[cards[0]['id']], teamId='a'))
        with connect(self.db) as c:
            payload = c.execute('SELECT payload FROM outbox').fetchone()[0]
        self.assertNotIn('병원', payload)

    def test_work_label_with_personal_words_holds(self):
        text = '수술 일정 때문에 이번 주 리뷰는 빠질게'
        self.pipeline.append([self.message('w', text)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.pipeline.rpc('privacy.list', {})['items'][0]['reason'], 'rule_model_conflict')

    def test_project_topic_words_are_not_personal_but_other_words_still_hold(self):
        self.pipeline.configure(dict(projectTopic='병원 예약 서비스'))
        self.pipeline.append([self.message('d', '병원 예약 시스템 API는 REST로 설계하자')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 1)
        self.pipeline.append([self.message('s', '수술 일정 때문에 이번 주 리뷰는 빠질게')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.pipeline.status()['counts']['privacyHeld'], 1)

    def test_earlier_personal_context_is_not_attached(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        self.pipeline.append([self.message('p', HEALTH)], True)
        self.run_offline()
        self.pipeline.append([self.message('w', 'API 명세는 내일 올릴게')], True)
        self.run_offline()
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(leaked(self.requests, '허리 통증'))

    def test_privacy_list_reports_excluded_messages_per_message_and_team(self):
        self.pipeline.configure(dict(turnsPerBatch=3))
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH]),
                                               MIXED: dict(label='mixed', personal=['병원 때문에'])}))
        self.pipeline.append([self.message('w', 'API 명세는 내일 올릴게'), self.message('p', HEALTH), self.message('m', MIXED)], True)
        self.run_offline()
        listed = self.pipeline.rpc('privacy.list', {})
        # Partial exclusion inside an allowed batch is listed; the redacted mixed message is not.
        self.assertEqual((listed['teamId'], listed['items'], listed['excludedCount']), ('a', [], 1))
        entry = listed['excluded'][0]
        self.assertEqual((entry['messageId'], entry['reason'], entry['role'], entry['site']), ('p', 'personal', 'user', 'chatgpt'))
        self.assertEqual(self.pipeline.status()['counts']['privacyExcluded'], 0, 'whole-batch count keeps its meaning')
        with connect(self.db) as c:
            c.execute("UPDATE job_context SET team_id='b'")
        self.assertEqual(self.pipeline.rpc('privacy.list', {})['excluded'], [])


class FailClosed(Base):
    def test_every_model_failure_holds_and_survives_restart(self):
        for mode in ('down', 'timeout', 'error', 'garbage'):
            with self.subTest(mode=mode):
                self.setUp()
                self.pipeline.privacy = Gate(Scripted(mode=mode))
                self.pipeline.append([self.message('m', 'API 명세는 내일 올릴게')], True)
                self.run_offline()
                self.assertEqual(self.requests, [])
                counts = self.pipeline.status()['counts']
                self.assertEqual((counts['privacyHeld'], counts['classificationPending']), (1, 0))
                restarted = Pipeline(self.db, Client())
                restarted.llm_factory, restarted.decider_factory = self.pipeline.llm_factory, (lambda: None)
                restarted.privacy = Gate(Scripted(mode=mode))
                with offline(self.requests):
                    restarted.process()
                self.assertEqual(self.requests, [])
                self.temp.cleanup()

    def test_unsure_holds_until_user_excludes_only_that_message(self):
        doubt = '그 사람 얘기는 나중에 따로 하자'
        self.pipeline.configure(dict(turnsPerBatch=2))
        self.pipeline.privacy = Gate(Scripted({doubt: dict(label='unsure', personal=[])}))
        self.pipeline.append([self.message('a', 'API 명세는 내일 올릴게'), self.message('b', doubt)], True)
        self.run_offline()
        self.assertEqual(self.requests, [])
        item = self.pipeline.rpc('privacy.list', {})['items'][0]
        self.assertEqual([m['decision'] for m in item['messages']], ['allow', 'hold'])
        # Restart: still held, still nothing sent.
        restarted = Pipeline(self.db, Client())
        restarted.llm_factory, restarted.decider_factory, restarted.privacy = self.pipeline.llm_factory, (lambda: None), self.pipeline.privacy
        with offline(self.requests):
            restarted.process()
        self.assertEqual(self.requests, [])
        with self.assertRaises(ValueError):
            restarted.rpc('privacy.exclude', dict(id=item['id'], teamId='b', messageId='b'))
        restarted.rpc('privacy.exclude', dict(id=item['id'], teamId='a', messageId='b'))
        with offline(self.requests):
            restarted.process()
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(leaked(self.requests, doubt))
        self.assertTrue(any('API 명세는 내일 올릴게' in s for s in strings(self.requests[0]['body'])))
        listed = restarted.rpc('privacy.list', {})
        self.assertEqual((listed['items'], [(e['messageId'], e['reason']) for e in listed['excluded']]), ([], [('b', 'user_excluded')]))

    def test_recheck_request_stays_held_until_the_worker_decides(self):
        gate = Gate(Scripted(mode='down'))
        self.pipeline.privacy = gate
        self.pipeline.append([self.message('m', 'API 명세는 내일 올릴게')], True)
        self.run_offline()
        job = self.pipeline.rpc('privacy.list', {})['items'][0]['id']
        self.assertEqual(self.pipeline.rpc('privacy.recheck', dict(id=job, teamId='a')), dict(queued=True))
        # queued is not done: still listed and counted as held, nothing sent.
        listed = self.pipeline.rpc('privacy.list', {})['items']
        self.assertEqual((listed[0]['reason'], self.pipeline.status()['counts']['privacyHeld']), ('recheck_requested', 1))
        self.assertEqual(self.requests, [])
        gate.classifier.mode = None
        self.run_offline()
        self.assertEqual((self.pipeline.rpc('privacy.list', {})['items'], len(self.requests)), ([], 1))

    def test_runtime_hold_rechecks_by_itself_once_the_model_is_back(self):
        gate = Gate(Scripted(mode='down'))
        self.pipeline.privacy = gate
        self.pipeline.append([self.message('m', 'API 명세는 내일 올릴게')], True)
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
        self.pipeline.append([self.message('m', 'API 명세는 내일 올릴게')], True)
        # Inject after the classifier's own masking too, so the final guard is actually exercised.
        with patch('ai.syncup_ai.classify.build_user_prompt', return_value=('Authorization: Bearer '+TOKEN, [])):
            self.run_offline()
        self.assertEqual(self.requests, [])
        self.assertEqual(self.count("SELECT count(*) FROM privacy_jobs WHERE decision='hold' AND reason='secret_in_payload'"), 1)

    def test_nothing_sensitive_in_logs_details_or_errors(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        stream = io.StringIO(); handler = logging.StreamHandler(stream)
        logging.getLogger('syncup').addHandler(handler); self.addCleanup(logging.getLogger('syncup').removeHandler, handler)
        self.pipeline.append([self.message('p', HEALTH), self.message('s', KEEP + '\n' + SECRETS['bearer_header'])], True)
        with patch('urllib.request.urlopen', side_effect=urllib.error.URLError(OSError('down'))), \
             patch('sys.stderr', new_callable=io.StringIO) as err:
            self.pipeline.process()
        with connect(self.db) as c:
            # Originals stay in intake/job_context by design; the gate's own records hold no raw secret or personal text.
            gate_rows = json.dumps([list(r) for t in ('privacy_jobs', 'privacy_results') for r in c.execute(f'SELECT * FROM {t}')], ensure_ascii=False)
            details = json.dumps([list(r) for r in c.execute('SELECT detail FROM jobs')], ensure_ascii=False)
        status = json.dumps(self.pipeline.status(), ensure_ascii=False)
        for text in (stream.getvalue(), err.getvalue(), status, gate_rows, details):
            self.assertNotIn('허리 통증', text); self.assertNotIn(TOKEN, text)
        self.assertIn('[액세스토큰]', gate_rows)


class LocalModelBoundary(unittest.TestCase):
    def test_only_loopback_and_local_models_are_accepted(self):
        for url in ('http://10.0.0.5:11434', 'https://127.0.0.1:11434', 'http://localhost:11434',
                    'http://127.0.0.1:11434/v1', 'http://user:pw@127.0.0.1:11434', 'http://api.example.com'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                OllamaClassifier('gemma3:12b', url)
        with self.assertRaises(ValueError):
            OllamaClassifier('gpt-oss:120b-cloud')
        with patch.dict('os.environ', SYNCUP_LOCAL_PRIVACY_URL='http://10.0.0.5:11434'):
            self.assertIsInstance(local_privacy.classifier_from_env(), local_privacy.UnconfiguredClassifier)
        with patch.dict('os.environ', SYNCUP_LOCAL_PRIVACY_MODEL=''):
            self.assertIsInstance(local_privacy.classifier_from_env(), local_privacy.UnconfiguredClassifier)

    def serve(self, show, chat):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, payload):
                data = json.dumps(payload).encode(); self.send_response(200)
                self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data)))
                self.end_headers(); self.wfile.write(data)
            def do_GET(self): self.reply(dict(models=[dict(name='fixture:1b', model='fixture:1b', digest='a' * 64)]))
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                self.server.bodies.append(body)
                if self.server.no_schema and 'format' in body:
                    data = b'{"error":"structured output is unavailable"}'
                    self.send_response(501); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
                    return
                self.reply(show if self.path == '/api/show' else chat)
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler); server.bodies = []; server.no_schema = False
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        return server

    def test_new_engine_without_schema_falls_back_to_strict_json(self):
        # Ollama 0.40 + gemma4/qwen3.5: 501 for schema output. Retry once without it; prose still fails closed.
        answer = dict(message=dict(content='```json\n' + json.dumps(dict(label='mixed', personal=['병원 때문에'])) + '\n```'))
        server = self.serve({}, answer); server.no_schema = True
        classifier = OllamaClassifier('fixture:1b', f'http://127.0.0.1:{server.server_port}', timeout=5)
        with offline([], loopback=True):
            self.assertEqual(classifier.classify(MIXED)['label'], 'mixed')
            self.assertFalse(classifier.structured)
            classifier.classify(MIXED)
        chats = [b for b in server.bodies if 'messages' in b]
        self.assertEqual(['format' in b for b in chats], [True, False, False], 'schema asked once, then plain JSON')
        self.assertTrue(all(b['keep_alive'] == '60s' for b in chats), 'fallback must not restore long residency')
        prose = self.serve({}, dict(message=dict(content='이건 업무 같아요'))); prose.no_schema = True
        with offline([], loopback=True), self.assertRaises(ModelOutputError):
            OllamaClassifier('fixture:1b', f'http://127.0.0.1:{prose.server_port}', timeout=5).classify(MIXED)

    def test_real_client_over_loopback_and_remote_model_refused(self):
        answer = dict(message=dict(content=json.dumps(dict(label='mixed', personal=['병원 때문에']))))
        server = self.serve({}, answer)
        classifier = OllamaClassifier('fixture:1b', f'http://127.0.0.1:{server.server_port}', timeout=5)
        with offline([], loopback=True):
            self.assertEqual(classifier.identity(), 'ollama:fixture:1b@aaaaaaaaaaaa')
            self.assertEqual(classifier.classify(MIXED)['label'], 'mixed')
        chat = server.bodies[-1]
        self.assertEqual(chat['keep_alive'], '60s')
        self.assertEqual((chat['stream'], chat['options']['temperature'], chat['format']['required']), (False, 0, ['label', 'personal']))
        remote = self.serve(dict(remote_host='https://ollama.com:443', remote_model='x'), answer)
        with offline([], loopback=True), self.assertRaises(ModelUnavailable):
            OllamaClassifier('fixture:1b', f'http://127.0.0.1:{remote.server_port}', timeout=5).identity()
        with offline([], loopback=True), self.assertRaises(ModelUnavailable):
            OllamaClassifier('fixture:1b', 'http://127.0.0.1:9', timeout=2).identity()

    def test_schema_fallback_rejects_ambiguous_json_wrappers(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        db = Path(temp.name) / 'privacy.sqlite'
        with connect(db) as c:
            local_privacy.initialize(c)
        valid = '{"label":"work","personal":[]}'
        invalid = [f'[{valid}]', f'불확실하지만 {valid}', f'{valid} 추가 설명',
                   valid + valid, '{"label":"unsure","label":"work","personal":[]}', None]
        for content in invalid:
            with self.subTest(content=content):
                classifier = OllamaClassifier('fixture:1b')
                unsupported = ModelError('local model HTTP 501'); unsupported.status = 501
                response = dict(message=dict(content=content))
                with patch.object(classifier, '_call', side_effect=[unsupported, response, response]) as call:
                    with self.assertRaises(ModelOutputError):
                        classifier.classify('합성 업무 문장')
                    result = Gate(classifier).check(db, '합성 업무 문장', 'user', 'fixture:1b')
                    self.assertEqual((result.decision, result.reason), (local_privacy.HOLD, 'model_output'))
                    self.assertEqual(result.sanitized, '')
                    self.assertEqual(call.call_count, 3)

    def test_pre_strict_parser_cache_is_not_reused(self):
        for old_policy in ('syncup-local-privacy/1', 'syncup-local-privacy/2'):
            temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
            db = Path(temp.name) / 'privacy.sqlite'
            text, identity = '합성 업무 문장', 'fixture:1b'
            with patch.object(local_privacy, 'POLICY_VERSION', old_policy):
                old_key = local_privacy._key(identity, 'user', text)
            with connect(db) as c:
                local_privacy.initialize(c)
                label = local_privacy._compact(text, dict(label='work', personal=[]))
                c.execute('INSERT INTO privacy_results VALUES(?,?,?,?,?)',
                          (old_key, old_policy, identity, json.dumps(label), time.time()))
            classifier = OllamaClassifier('fixture:1b')
            with patch.object(classifier, 'classify', side_effect=ModelOutputError('ambiguous answer')) as classify:
                result = Gate(classifier).check(db, text, 'user', identity)
            self.assertEqual((result.decision, result.reason), (local_privacy.HOLD, 'model_output'))
            classify.assert_called_once_with(text)


class LegacyCollector(unittest.TestCase):
    """The older collector (Rust excerpts -> OpenAI) also passes the gate."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'private.sqlite'; initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (self.temp.name, time.time() - 10, time.time() + 600))

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
            collector.process(self.db, gate=gate)
        self.assertEqual([r['url'].rsplit('/', 1)[-1] for r in requests], ['responses'])
        self.assertFalse(leaked(requests, 'SyntheticOnlyAbCdEf' * 3))
        self.assertFalse(leaked(requests, '허리 통증'))
        with connect(self.db) as c:
            self.assertEqual(dict(c.execute('SELECT id,state FROM jobs')), dict(secret='done', health='done'))

    def test_legacy_hold_when_model_missing(self):
        self.job('n', 'new', [dict(n=1, role='user', text='API 명세는 내일 올릴게')])
        requests = []
        with patch.dict('os.environ', OPENAI_API_KEY=FAKE_AUTH), offline(requests):
            collector.process(self.db, gate=Gate(Scripted(mode='down')))
        self.assertEqual(requests, [])
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT state FROM jobs').fetchone()[0], 'new')


if __name__ == '__main__':
    unittest.main()
