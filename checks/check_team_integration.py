"""Integrated HTTP, native transport, SQLite and real PostgreSQL checks."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
from contextlib import contextmanager
import http.server
import json
import secrets
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

import psycopg

from ai.syncup_ai.llm import DecisionsClient
from batch_classification import classify_queued
from check_teams import TeamIsolation, own_tests, request, running_server
from collection_settings import configure
from local_fixtures import AI, public_card, work_gate
from native_host import request as native_request
from review_page import Review
from storage import connect
from turn_pipeline import TurnPipeline


def checked(req, conflicts=None):
    """A conflict engine answer that judged every candidate '무관' and reports `conflicts`."""
    return dict(ok=True, checkStatus='complete', conflicts=conflicts or [],
                results=[dict(cardId=req['newCards'][0]['id'], judgements=[
                    dict(id=c['id'], judgement='무관', confidence=.9, method='chat') for c in req['existing']])])


def answers(body, choice, confidence=.9):
    """A Decisions API reply giving `choice` to every question in the request body."""
    return json.dumps(dict(answers=[dict(name=q['name'], type='choice', choice=choice, confidence=confidence)
                                    for q in body['questions']])).encode()


@contextmanager
def stub_model(respond):
    """A local stand-in for the AI service; respond(path, raw body) returns (status, reply). Yields the base URL."""
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            status, reply = respond(self.path, self.rfile.read(int(self.headers['Content-Length'])))
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(reply)))
            self.end_headers()
            try:
                self.wfile.write(reply)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the API process that asked was killed before reading the reply
    with running_server(Model) as srv:
        yield f'http://127.0.0.1:{srv.server_port}/v1'


@contextmanager
def decisions_model(client):
    """Judge pairs with `client` as the Decisions model and no chat model, as the team server would."""
    with patch('conflict_checks.from_env', return_value=None), \
            patch('conflict_checks.decider_from_env', return_value=client):
        yield


def decisions_api(base_url):
    """decisions_model() with the real Decisions client pointed at a stub_model() URL."""
    return decisions_model(DecisionsClient(base_url, 'synthetic-key'))


class TeamIntegration(TeamIsolation):
    def publish_card(self, identifier, text, tag='decision', topic='DB'):
        card = public_card(text)
        card.update(content=text, tag=tag, topic_key=topic)
        packet = dict(id=identifier, label='할 일' if tag == 'todo' else '결정', text=text, quote=text,
                      speaker='사용자', version=2, card=card)
        envelope = dict(packet=packet, approved_by=self.users['Dana'], approved_at=time.time())
        status, body = request(self.api, 'POST', self.path('A'), self.tokens['Dana'], envelope)
        self.assertEqual(status, 200, body)

    def check_pair(self, pair='pair', judgement='변경'):
        """Run the due checks with an engine that reports one `judgement` alert against the earlier decision."""
        def engine(req):
            new, old = req['newCards'][0], [c for c in req['existing'] if c['tag'] == 'decision']
            alerts = [dict(id=pair, topic_key='DB', cardA=old[0], cardB=new, judgement=judgement,
                           reason='가상 판정', confidence=.9, method='chat')] if old else []
            return checked(req, alerts)
        self.api.conflict_engine = engine
        self.run_due_checks()

    def change_after_discussion(self):
        """Old vs new decision: the team discusses, then adopts the new one."""
        self.publish_card('old', 'SQLite로 결정했다.')
        self.publish_card('new', 'PostgreSQL로 변경했다.')
        self.check_pair()
        self.assertEqual(len(self.team_request('GET', 'conflicts')[1]['conflicts']), 1)
        self.assertEqual(self.team_request('POST', 'conflicts/pair/resolve', dict(resolution='discuss'))[0], 200)
        self.assertEqual(len(self.team_request('GET', 'conflicts')[1]['conflicts']), 1)
        resolution = dict(resolution='adopt-new', resolutionNote='예')
        self.assertEqual(self.team_request('POST', 'conflicts/pair/resolve', resolution)[0], 200)

    def assert_late_worker_loses_lease(self):
        """A member retries while the engine is still judging; the late verdict must not replace the new lease."""
        self.publish_card('late', 'SQLite로 결정했다.')
        entered, release = threading.Event(), threading.Event()
        errors = []

        def engine(req):
            entered.set()
            if not release.wait(10):
                raise TimeoutError()
            return checked(req)

        def run():
            try:
                self.run_due_checks()
            except Exception as error:
                errors.append(type(error).__name__)
        self.api.conflict_engine = engine
        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with self.team_db() as c:
                c.execute("UPDATE syncup.conflict_checks SET state='failed'")
            self.assertEqual(self.team_request('POST', 'items/late/retry-check', {})[0], 200)
            # A new lease with the same attempt number as the late worker's, so only the lease time differs.
            with self.team_db() as c:
                c.execute("""UPDATE syncup.conflict_checks
                    SET state='running',attempts=1,next_attempt=clock_timestamp()+interval '3 minutes'""")
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.team_request('GET', 'board')[1]['items'][0]['conflictCheckStatus'], 'running')

    def test_change_yes_discuss_and_history(self):
        self.change_after_discussion()
        self.assertEqual([c['id'] for c in self.team_request('GET', 'board')[1]['items']], ['new'])
        self.assertEqual(self.team_request('GET', 'history')[1]['items'][0]['decisionState'], 'superseded')
        events = self.team_request('GET', 'conflicts/history')[1]['events']
        self.assertEqual([e['resolution'] for e in events], ['discuss', 'adopt-new'])
        self.assertEqual(self.team_request('POST', 'conflicts/pair/resolve', dict(resolution='keep-existing'))[0], 409)
        with self.team_db() as c:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                c.execute("UPDATE syncup.conflict_events SET note='tamper'")

    def test_change_no_and_both_valid(self):
        self.publish_card('old', 'SQLite로 결정했다.')
        self.publish_card('new', 'PostgreSQL로 변경했다.')
        self.check_pair()
        self.assertEqual(self.team_request('POST', 'conflicts/pair/resolve', dict(resolution='keep-existing'))[0], 200)
        self.assertEqual([c['id'] for c in self.team_request('GET', 'board')[1]['items']], ['old'])
        self.publish_card('third', '두 DB를 병행한다.')
        self.check_pair('pair2', '충돌')
        self.assertEqual(self.team_request('POST', 'conflicts/pair2/resolve', dict(resolution='both-valid'))[0], 200)
        self.assertEqual(len(self.team_request('GET', 'board')[1]['items']), 2)
        self.assertFalse(self.team_request('GET', 'conflicts')[1]['conflicts'])

    def test_malformed_card_id_is_rejected_before_lookup(self):
        self.publish_card('todo', '내일까지 발표를 준비한다.', 'todo')
        for suffix, data in [('items/%FF/done', dict(done=True)), ('items/%FF/retry-check', {}),
                             ('conflicts/%FF/resolve', dict(resolution='discuss')), ('items/%FF', None)]:
            with self.subTest(suffix=suffix):
                self.assertEqual(self.team_request('POST' if data is not None else 'GET', suffix, data)[0], 400)

    def test_failure_retry_other_team_and_todo(self):
        self.publish_card('one', 'SQLite로 결정했다.')
        self.api.conflict_engine = lambda req: dict(ok=False)
        self.run_due_checks()
        self.assertEqual(self.team_request('GET', 'board')[1]['items'][0]['conflictCheckStatus'], 'failed')
        for suffix in ('board', 'history', 'conflicts', 'conflicts/history', 'todos/done'):
            self.assertEqual(self.team_request('GET', suffix, user='Bob')[0], 403)
        self.assertEqual(self.team_request('POST', 'items/one/retry-check', {}, user='Bob')[0], 403)
        self.assertEqual(self.team_request('POST', 'items/one/retry-check', {})[0], 200)
        self.api.conflict_engine = checked
        self.run_due_checks()
        self.assertEqual(self.team_request('GET', 'board')[1]['items'][0]['conflictCheckStatus'], 'complete')
        self.publish_card('todo', '내일까지 발표를 준비한다.', 'todo')
        self.assertEqual(self.team_request('POST', 'items/todo/done', dict(done=True))[0], 200)
        self.assertEqual(self.team_request('GET', 'todos/done')[1]['ids'], ['todo'])

    def test_legacy_decision_is_not_reported_as_skipped_inactive(self):
        # Approvals without card details keep the old packet format and have no decision-state row.
        self.assertEqual(self.publish('Dana', 'A', 'legacy', text='예전 형식 결정')[0], 200)
        self.publish_card('new', 'PostgreSQL로 결정했다.')
        self.api.conflict_engine = checked
        self.run_due_checks()
        self.assertEqual(self.board_item('legacy')['decisionState'], 'active')
        item = self.board_item('new')
        self.assertEqual((item['conflictCheckStatus'], item['conflictCheckDetail'], item['conflictCheckProgress']),
                         ('complete', '', dict(total=0, completed=0, skipped=0)))

    def test_decisions_batches_failure_retry_and_team_boundary(self):
        calls = []
        fail_second = [True]

        def respond(path, raw):
            body = json.loads(raw)
            calls.append((path, body))
            if fail_second[0] and len(calls) == 2:
                return 200, json.dumps(dict(answers=[])).encode()
            return 200, answers(body, '충돌' if 'CROSS_KEY_TARGET' in body['input'] else '무관')
        model = self.enterContext(stub_model(respond))
        for i in range(3):
            self.publish_card('old'+str(i), 'NEIGHBOR_'+str(i))
        self.publish_card('alias', 'CROSS_KEY_TARGET', topic='다른 이름')
        self.publish_card('inactive', 'INACTIVE_SENTINEL')
        self.publish_card('todo', 'TODO_SENTINEL', tag='todo')
        # A valid approved decision in another team must never enter the model input.
        card = public_card('OTHER_TEAM_SENTINEL')
        packet = dict(id='other-team', label='결정', text=card['content'], quote=card['sentence'], speaker='사용자',
                      version=2, card=card)
        status, body = request(self.api, 'POST', self.path('B'), self.tokens['Bob'],
                               dict(packet=packet, approved_by=self.users['Bob'], approved_at=time.time()))
        self.assertEqual(status, 200, body)
        with self.team_db() as c:
            c.execute("UPDATE syncup.record_states SET state='superseded' WHERE team_id=%s AND card_id='inactive'",
                      (self.teams['A'],))
        self.settle_checks()
        self.publish_card('new', 'NEW_DECISION')
        with decisions_api(model):
            self.run_due_checks()
            self.assertEqual(len(calls), 2)
            self.assertFalse(self.team_request('GET', 'conflicts')[1]['conflicts'])
            self.assertEqual(self.board_item('new')['conflictCheckStatus'], 'failed')
            self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
            fail_second[0] = False
            calls.clear()
            self.run_due_checks()
        # The first pair was committed before the failure, so only the remaining three are asked again.
        self.assertEqual([len(body['questions']) for _, body in calls], [1, 1, 1])
        self.assertTrue(all(path == '/v1/decisions' for path, _ in calls))
        prompts = '\n'.join(body['input'] for _, body in calls)
        for marker in ('OTHER_TEAM_SENTINEL', 'INACTIVE_SENTINEL', 'TODO_SENTINEL'):
            self.assertNotIn(marker, prompts)
        self.assertIn('CROSS_KEY_TARGET', calls[-1][1]['input'])
        self.assertEqual(self.board_item('new')['conflictCheckStatus'], 'complete')
        found = self.team_request('GET', 'conflicts')[1]['conflicts']
        self.assertEqual(len(found), 1)
        alert = found[0]
        self.assertEqual((alert['cardA']['id'], alert['cardB']['id'], alert['method']), ('alias', 'new', 'decisions'))

    def test_uncertain_check_stays_failed_until_explicit_retry(self):
        calls = []
        confidence = [.4]

        def respond(path, raw):
            body = json.loads(raw)
            calls.append(body)
            return 200, answers(body, '무관', confidence[0])
        model = self.enterContext(stub_model(respond))
        self.publish_card('old', '기존 결정')
        self.settle_checks()
        self.publish_card('new', '새 결정')
        with decisions_api(model):
            self.run_due_checks()
            self.assertEqual([len(b['questions']) for b in calls], [1])
            item = self.board_item('new')
            self.assertEqual(item['conflictCheckStatus'], 'failed')
            self.assertIn('확인 필요', item['conflictCheckDetail'])
            self.assertIn('확신도 부족', item['conflictCheckDetail'])
            self.assertFalse(self.team_request('GET', 'conflicts')[1]['conflicts'])
            self.make_check_due('new')
            self.run_due_checks()
            self.assertEqual(len(calls), 1)
            confidence[0] = .9
            self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
            self.run_due_checks()
        self.assertEqual(self.board_item('new')['conflictCheckStatus'], 'complete')
        self.assertEqual(len(calls), 2)

    def test_actual_transport_retry_waits_and_stops_at_three_attempts(self):
        calls = []
        available = [False]

        def respond(path, raw):
            body = json.loads(raw)
            calls.append(body)
            return (200, answers(body, '충돌')) if available[0] else (503, json.dumps(dict(error='temporary')).encode())
        model = self.enterContext(stub_model(respond))
        self.publish_card('old', '기존 결정')
        self.settle_checks()
        self.publish_card('new', '새 결정')
        with decisions_api(model):
            for attempt in range(1, 4):
                self.run_due_checks()
                self.assertEqual(len(calls), attempt)
                with self.team_db() as c:
                    row = c.execute("""SELECT state,attempts,next_attempt>now() AS waiting
                        FROM syncup.conflict_checks WHERE card_id='new'""").fetchone()
                self.assertEqual(row['attempts'], attempt)
                self.assertEqual(row['state'], 'pending' if attempt < 3 else 'failed')
                self.assertTrue(row['waiting'])
                self.run_due_checks()
                self.assertEqual(len(calls), attempt)
                self.make_check_due('new')
            self.run_due_checks()
            self.assertEqual(len(calls), 3)
            self.assertFalse(self.team_request('GET', 'conflicts')[1]['conflicts'])
            self.assertEqual(self.team_request('POST', 'items/new/retry-check', {}, user='Bob')[0], 403)
            self.assertEqual(self.team_request('POST', 'items/new/retry-check', {})[0], 200)
            available[0] = True
            self.run_due_checks()
            self.assertEqual(len(calls), 4)
            item = self.board_item('new')
            self.assertEqual(item['conflictCheckStatus'], 'complete')
            self.assertEqual(item['conflictCheckDetail'], '')
            self.assertEqual(len(self.team_request('GET', 'conflicts')[1]['conflicts']), 1)
            self.publish_card('recovered', '통신 복구 후 결정')
            available[0] = False
            self.run_due_checks()
            self.make_check_due('recovered')
            available[0] = True
            self.run_due_checks()
            with self.team_db() as c:
                row = c.execute("SELECT state,attempts FROM syncup.conflict_checks WHERE card_id='recovered'").fetchone()
            # Retry budget resets after each committed pair; the review-state decision also participates.
            self.assertEqual((row['state'], row['attempts']), ('complete', 1))
            item = self.board_item('recovered')
            self.assertEqual(item['conflictCheckProgress'], dict(total=2, completed=2, skipped=0))

    def test_unknown_interruption_and_legacy_failure_require_manual_retry(self):
        self.publish_card('interrupted', '중단된 결정')
        self.publish_card('legacy', '이전 버전 실패')
        with self.team_db() as c:
            # Rows from before checkpoints existed: an expired lease without progress, and an old failure.
            c.execute("""UPDATE syncup.conflict_checks
                SET state='running',attempts=1,next_attempt=now()-interval '1 minute' WHERE card_id='interrupted'""")
            c.execute("""UPDATE syncup.conflict_checks
                SET state='failed',attempts=1,next_attempt=now()-interval '1 minute' WHERE card_id='legacy'""")
        with patch('conflict_checks.check_conflicts') as engine:
            self.run_due_checks()
            engine.assert_not_called()
        items = self.team_request('GET', 'board')[1]['items']
        self.assertTrue(all(c['conflictCheckStatus'] == 'failed' for c in items))
        self.assertEqual(len(items), 2)
        self.assertEqual(self.team_request('POST', 'items/interrupted/retry-check', {})[0], 200)

    def test_actual_permanent_and_invalid_responses_never_auto_retry(self):
        calls = []
        mode = [401]

        def respond(path, raw):
            calls.append(raw)
            if mode[0] == 'json':
                return 200, b'not-json'
            return (mode[0] if isinstance(mode[0], int) else 200), b'{}'
        model = self.enterContext(stub_model(respond))
        self.publish_card('old', '기존 결정')
        self.settle_checks()
        with decisions_api(model):
            for i, value in enumerate([400, 401, 403, 422, 'json', 'missing']):
                mode[0] = value
                identifier = 'invalid-'+str(i)
                self.publish_card(identifier, '새 결정')
                self.run_due_checks()
                self.assertEqual(len(calls), i+1)
                with self.team_db() as c:
                    row = c.execute('SELECT state,attempts FROM syncup.conflict_checks WHERE card_id=%s',
                                    (identifier,)).fetchone()
                self.assertEqual((row['state'], row['attempts']), ('failed', 1))
                self.make_check_due(identifier)
                self.run_due_checks()
                self.assertEqual(len(calls), i+1)
        self.assertFalse(self.team_request('GET', 'conflicts')[1]['conflicts'])

    def test_native_http_approval_delivery(self):
        with connect(self.db) as c:
            c.execute('UPDATE settings SET end=?', (time.time()+600,))
        pipeline = TurnPipeline(self.db, self.client)
        pipeline.llm_factory = lambda: AI()
        pipeline.decider_factory = lambda: None
        pipeline.privacy = work_gate()
        configure(pipeline, dict(projectTopic='가상 통합 검사'))
        srv = self.enterContext(running_server(Review))
        srv.db = self.db
        srv.pipeline = pipeline
        srv.rpc_secret = secrets.token_urlsafe(32)
        connection, registration = self.native_host(srv)
        self.assertEqual(registration['allowed_origins'], ['chrome-extension://'+'a'*32+'/'])
        self.assertTrue(self.native_frame(registration, 'collection.status')['ok'])
        other = subprocess.run([registration['path'], 'chrome-extension://'+'b'*32+'/'], input=b'',
                               capture_output=True, timeout=5)
        self.assertNotEqual(other.returncode, 0)

        def rpc(method, params=None):
            result = native_request(connection, dict(version=1, method=method, params=params or {}))
            self.assertTrue(result['ok'], result)
            return result['result']
        msg = dict(id='m1', conversationId='manual', site='manual', role='user', text='SQLite로 결정했다.',
                   collectedAt='2026-11-08T00:00:00+09:00')
        rpc('turns.append', dict(messages=[msg], flush=True))
        classify_queued(pipeline)
        card = rpc('candidates.list')['cards'][0]
        rpc('candidates.update', dict(id=card['id'], patch=dict(content='검토 후 승인 문구')))
        rpc('candidates.approve', dict(ids=[card['id']], teamId=self.teams['A']))
        self.assertTrue(self.deliver())
        board = rpc('team.board')['items']
        self.assertEqual(board[0]['content'], '검토 후 승인 문구')
        self.assertFalse(rpc('candidates.list')['cards'])
        self.assertNotIn('messageId', json.dumps(board))
        unauthenticated = dict(version=1, method='collection.status', params={})
        self.assertEqual(request(srv, 'POST', '/rpc', data=unauthenticated)[0], 403)


def load_tests(loader, tests, pattern):
    return own_tests(TeamIntegration)


if __name__ == '__main__':
    unittest.main(verbosity=2)
