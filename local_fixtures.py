"""Synthetic fixtures shared by the local checks. No TestCase with tests lives here, so importing it runs nothing twice.

Fake team client and external AI, scripted local privacy model, offline network capture, a ready private database and
pipeline, loopback HTTP servers and requests, child-process waits.
"""
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import http.client
import http.server
import io
import json
from pathlib import Path
import queue
import socket
import tempfile
import threading
import time
import unittest
import urllib.parse
from unittest.mock import patch

from ai.syncup_ai import llm
from batch_classification import classify_queued
from candidate_review import list_candidates
from collection_settings import configure
from local_privacy import Gate
from privacy_model import ModelError, ModelOutputError, ModelTimeout, ModelUnavailable
from storage import connect, initialize
import turn_intake
from turn_pipeline import TurnPipeline

# Seconds a child process may take to print its first line (the review service or the board is listening).
READY_TIMEOUT = 8
# Synthetic privacy inputs: a work line that must survive, secrets and contacts that must not, personal text.
KEEP = 'SQLite 사용을 결정했다. PRIVACY_CANARY_KEEP 날짜 2026-11-08'
FAKE_AUTH = 'synthetic-transport-key-not-a-real-credential'  # external AI key in tests; never sent anywhere
TOKEN = 'SyntheticToken_AbCdEfGhIjKlMnOpQrStUvWxYz01'  # 43 characters, like a team connection key
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
# The part of each line that must never reach a request.
HIDDEN = {
    'openai_project': 'sk-proj-' + 'SyntheticOnlyAbCdEf' * 7,
    'openai_legacy': 'sk-' + 'SyntheticOnlyAbCd' * 3,
    'github_classic': 'ghp_' + 'SyntheticOnlyAbCdEf' * 2,
    'github_fine_grained': 'github_pat_' + 'SyntheticOnlyAbCdEf' * 4,
    'url_password': 'Synthetic-Pass-0042',
    'email_control': 'synthetic.person@example.invalid',
    'phone_control': '010-0000-0000',
} | dict.fromkeys(('bearer_header', 'bearer_lowercase', 'json_token', 'access_token_assignment', 'json_access_token',
                   'bare_token'), TOKEN)
HEALTH = '요즘 허리 통증 때문에 병원 다니고 있어서 너무 힘들다'
MIXED = '병원 때문에 발표자료는 금요일에 공유할게'


class WorkOnly:
    """Local privacy model stand-in: every input is work, so suites about other parts keep a deterministic AI."""
    def identity(self):
        return 'test:work-only'

    def classify(self, text):
        return dict(label='work', personal=[])


def work_gate():
    return Gate(WorkOnly())


class Scripted:
    """Local privacy model stand-in. Labels by substring; failure modes raise what the real client raises."""
    FAILURES = {'timeout': ModelTimeout, 'error': ModelError, 'garbage': ModelOutputError}

    def __init__(self, labels=None, mode=None):
        self.labels, self.mode = labels or {}, mode

    def identity(self):
        if self.mode == 'down':
            raise ModelUnavailable('runtime down')
        return 'test:scripted'

    def classify(self, text):
        if self.mode in self.FAILURES:
            raise self.FAILURES[self.mode]('fault')
        for needle, label in self.labels.items():
            if needle in text:
                return label
        return dict(label='work', personal=[])


class Client:
    """Team client stand-in: user 'user' in teams 'a' and 'b'."""
    api_url = 'https://example.test/'
    user_id = 'user'

    def me(self):
        return dict(user_id='user', name='테스트', teams=[dict(id='a', name='팀 A'), dict(id='b', name='팀 B')])


class AI:
    """External AI stand-in: one decision card quoting 'SQLite로 결정했다.' (the reference turn when one is attached)."""
    before_request = None

    def __init__(self):
        self.calls = []
        self.fail = False
        self.invented = False

    def chat_json(self, system, user):
        self.before_request()
        self.calls.append(user)
        if self.fail:
            raise RuntimeError('test outage')
        sentence = '없는 근거' if self.invented else 'SQLite로 결정했다.'
        return dict(cards=[dict(msg=2 if '[참고용]' in user else 1, relevance='related', tag='decision', subtopic='작업·결과물',
                                sentence=sentence, content='DB = SQLite', topic_key='DB', confidence=.95, owner='테스트')])


def public_card(text='SQLite로 결정했다.'):
    """A valid public (version 2) decision card."""
    return dict(sentence=text, relevance='related', subtopic='작업·결과물', tag='decision', topic_key='DB',
                is_new_topic=True, content='DB = SQLite', reason=None, owner='테스트', due=None,
                is_change=False, source='가상 대화', masked=False, confidence=.9, classificationMethod='chat')


def private_db(folder, bound=True):
    """private.sqlite in folder with a collection session running for ten more minutes, bound to team 'a'."""
    db = Path(folder) / 'private.sqlite'
    initialize(db)
    with connect(db) as c:
        c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (str(folder), time.time() - 10, time.time() + 600))
        if bound:
            c.execute("INSERT INTO sharing VALUES(1,?,'user','a')", (Client.api_url,))
    return db


def make_pipeline(db, llm_factory, privacy):
    """A pipeline on db with the given AI and gate, no decider, one turn per batch and project topic 'SyncUp'."""
    pipeline = TurnPipeline(db, Client())
    pipeline.llm_factory = llm_factory
    pipeline.decider_factory = lambda: None
    pipeline.privacy = privacy
    configure(pipeline, dict(projectTopic='SyncUp', turnsPerBatch=1))
    return pipeline


class PipelineFixture(unittest.TestCase):
    """A pipeline with the fake AI and an always-work gate on a fresh private database."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = temp
        self.db = private_db(temp.name)
        self.ai = AI()
        self.pipeline = make_pipeline(self.db, lambda: self.ai, work_gate())

    def message(self, identifier='one', guessed=False):
        return dict(id=identifier, site='manual', conversationId='conv', role='user', roleGuessed=guessed,
                    text='SQLite로 결정했다.', collectedAt=datetime.now(timezone.utc).isoformat())

    def candidate(self, guessed=False):
        turn_intake.append(self.pipeline, [self.message(guessed=guessed)], True)
        classify_queued(self.pipeline)
        return list_candidates(self.pipeline)[0]['id']


class PrivacyFixture(unittest.TestCase):
    """A pipeline with a scripted local privacy model; every external request is captured offline."""
    def setUp(self):
        self.fresh()

    def fresh(self):
        """A new private database, pipeline and request log; sub-cases call it so they never share state."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = private_db(temp.name)
        self.pipeline = make_pipeline(self.db, lambda: llm.OpenAIResponses(FAKE_AUTH), Gate(Scripted()))
        self.requests = []

    def message(self, identifier, text, site='chatgpt', role='user'):
        return dict(id=identifier, site=site, conversationId='conv', role=role, roleGuessed=False, text=text,
                    collectedAt=datetime.now(timezone.utc).isoformat())

    def run_offline(self, reply=None):
        with offline(self.requests, reply):
            classify_queued(self.pipeline)

    def count(self, sql, *args):
        with connect(self.db) as c:
            return c.execute(sql, args).fetchone()[0]


@contextmanager
def offline(requests, reply=None, loopback=False):
    """Capture every urlopen body; refuse any other socket. Nothing leaves the machine."""
    real_connect, real_resolve = socket.socket.connect, socket.getaddrinfo

    def connect_socket(sock, address):
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
        stack.enter_context(patch('socket.socket.connect', connect_socket))
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


@contextmanager
def server(handler, db):
    """handler on a loopback port with fixture secrets; the review page links to it as its board."""
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    srv.db, srv.secret, srv.csrf = db, "fixture-only", "fixture-csrf"
    srv.board_url = f"http://127.0.0.1:{srv.server_port}/"
    srv.team_client = srv.pipeline = None
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


def _send(srv, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
    try:
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def post(srv, path, fields, board=False, origin=None):
    """(status, body). A form post (with the fixture csrf unless fields name one), or a board approval with board=True.

    fields may be a list of pairs to repeat a field.
    """
    if board:
        return _send(srv, "POST", path, json.dumps(fields).encode(), {"Authorization": "Bearer " + srv.secret})
    pairs = list(fields.items()) if isinstance(fields, dict) else list(fields)
    if not any(name == 'csrf' for name, _ in pairs):
        pairs.insert(0, ('csrf', srv.csrf))
    return _send(srv, "POST", path, urllib.parse.urlencode(pairs).encode(),
                 {"Origin": origin or f"http://127.0.0.1:{srv.server_port}"})


def get_page(srv, path='/'):
    """(status, decoded body) of a GET."""
    status, body = _send(srv, "GET", path)
    return status, body.decode()


def free_ports(count):
    """Loopback ports that were free a moment ago (bound, read and released together)."""
    sockets = [socket.socket() for _ in range(count)]
    try:
        for s in sockets:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in sockets]
    finally:
        for s in sockets:
            s.close()


def first_line(child, timeout=READY_TIMEOUT):
    """The child's first stdout line, or None when it printed nothing in time."""
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
    try:
        return lines.get(timeout=timeout)
    except queue.Empty:
        return None


def wait_until(condition, timeout=5, interval=.05):
    """True as soon as condition() is true, False after timeout seconds."""
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            return False
        time.sleep(interval)
    return True
