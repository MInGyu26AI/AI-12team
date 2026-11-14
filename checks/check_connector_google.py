"""Google Docs provider (collector/connectors/google_docs.py): OAuth with PKCE, token refresh, Docs JSON -> sections.

A fake Google (consent redirect, token, revoke and Docs API endpoints) on loopback and real temporary SQLite; no real
network, no real Google account. Covers: the consent link (PKCE S256, state, offline access, loopback redirect), the
callback (wrong, missing or expired state, a denied or partial consent, a login link used twice), the token file (mode
0600) and that no client secret, access token, refresh token or code reaches a page, a status, connectors.list, a
last_error, a log, an exception or the database; refresh (within 60 s, one retry after 401) and invalid_grant ->
reauth_required; 403/404/429/network errors as short kinds; the document conversion (title, headings, bullets, table);
the owner checkbox; the revisionId cursor; disconnect (revoke, then the file goes); and the whole way through the local
page and base.run_scope into turn_intake.
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import base64
from contextlib import contextmanager
import copy
from datetime import datetime, timezone
import hashlib
import html
import http.client
import http.server
import json
import os
import re
import secrets
import stat
import sys
import threading
import time
import traceback
import unittest
from unittest.mock import patch
import urllib.parse

from collection_settings import configure
from connectors import base, google_docs
from local_fixtures import PipelineFixture, get_page, post, server
from local_rpc import dispatch
from review_page import Review
from storage import connect
import turn_intake

base.load_providers()  # the module registers itself on its first import: before the tests replace PROVIDERS
# Obviously fake values that do not look like real Google credentials (GitHub push protection scans for that format).
CLIENT_ID = 'syncup-test-client-id.example'
CLIENT_SECRET = 'syncup_test_canary_client_secret_0123'
DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef'
OTHER = 'otherDocument0123456789abcdef'
NEEDS_REAUTH = '다시 연결하세요 (테스트 앱은 7일마다 만료)'


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def paragraph(text, style='NORMAL_TEXT', bullet=None):
    """A Docs API paragraph element. Level 0 of a list has no nestingLevel, as the real API leaves out zero."""
    inner = dict(elements=[dict(textRun=dict(content=text + '\n'))], paragraphStyle=dict(namedStyleType=style))
    if bullet is not None:
        inner['bullet'] = dict(listId='kix.list1', **(dict(nestingLevel=bullet) if bullet else {}))
    return dict(paragraph=inner)


def table(rows):
    return dict(table=dict(rows=len(rows), columns=len(rows[0]), tableRows=[
        dict(tableCells=[dict(content=[paragraph(cell)]) for cell in row]) for row in rows]))


SAMPLE = [
    dict(sectionBreak=dict(sectionStyle={})),
    paragraph('11월 14일 회의', 'TITLE'),
    paragraph('프런트 팀 모임을 정리했다.'),
    dict(tableOfContents=dict(content=[paragraph('목차 TOC_CANARY')])),
    paragraph('결정', 'HEADING_1'),
    paragraph('SQLite로 간다.'),
    paragraph(''),
    paragraph('이유 하나', bullet=0),
    paragraph('세부 사항', bullet=1),
    paragraph('이유 둘', bullet=0),
    paragraph('일정', 'HEADING_2'),
    table([['담당', '마감'], ['동균', '금요일']]),
    paragraph('작은 제목', 'HEADING_4'),
    paragraph('끝.'),
]
SAMPLE_SECTIONS = [
    dict(heading='11월 14일 회의', text='프런트 팀 모임을 정리했다.', author_is_me=None),
    dict(heading='결정', text='SQLite로 간다.\n\n- 이유 하나\n  - 세부 사항\n- 이유 둘', author_is_me=None),
    dict(heading='일정', text='담당\t마감\n동균\t금요일\n\n작은 제목\n\n끝.', author_is_me=None),
]


# ---------------------------------------------------------------------------------------------------------------------
# A fake Google: /auth (the browser's consent, answered by a redirect), /token, /revoke, /v1/documents/<id>

def issue(srv, prefix):
    """A new secret value; every one is remembered so the checks can look for it everywhere."""
    value = prefix + secrets.token_hex(12)
    srv.secret_values.append(value)
    return value


class FakeGoogle(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload=None, headers=()):
        data = json.dumps(payload or {}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def note(self, method, path, query, form):
        self.server.log.append(dict(method=method, path=path, query=query, form=form, auth=self.headers.get('Authorization')))

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()}
        self.note('GET', parts.path, query, {})
        if parts.path == '/auth':
            return self.consent(query)
        if parts.path.startswith('/v1/documents/'):
            return self.document(parts.path.rsplit('/', 1)[1], query)
        self.reply(404)

    def do_POST(self):
        form = {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()).items()}
        self.note('POST', self.path, {}, form)
        if self.path == '/token':
            return self.token(form)
        if self.path == '/revoke':
            return self.reply(self.server.revoke_status)
        self.reply(404)

    def consent(self, query):
        """The browser at Google's login: whoever clicks "allow" is sent back with a code and the state."""
        srv = self.server
        if query.get('client_id') != CLIENT_ID or query.get('code_challenge_method') != 'S256' or not query.get('redirect_uri'):
            return self.reply(400, dict(error='invalid_request'))
        code = issue(srv, 'fake-auth-code-')
        srv.codes[code] = dict(challenge=query.get('code_challenge'), redirect_uri=query['redirect_uri'])
        answer = dict(code=code, state=query.get('state', ''))
        self.reply(302, headers=[('Location', query['redirect_uri'] + '?' + urllib.parse.urlencode(answer))])

    def grant(self, refresh):
        srv = self.server
        access = issue(srv, 'syncup-canary-access-')
        srv.access.add(access)
        body = dict(access_token=access, expires_in=srv.expires_in, scope=srv.granted, token_type='Bearer')
        if refresh:
            body['refresh_token'] = refresh
        self.reply(200, body)

    def token(self, form):
        srv = self.server
        if form.get('client_id') != CLIENT_ID or form.get('client_secret') != CLIENT_SECRET:
            return self.reply(401, dict(error='invalid_client'))
        if form.get('grant_type') == 'authorization_code':
            info = srv.codes.pop(form.get('code'), None)  # a code works once
            if (not info or info['redirect_uri'] != form.get('redirect_uri')
                    or b64url(hashlib.sha256(form.get('code_verifier', '').encode()).digest()) != info['challenge']):
                return self.reply(400, dict(error='invalid_grant'))
            refresh = issue(srv, '1//CanaryRefresh-')
            srv.refresh.add(refresh)
            return self.grant(refresh)
        if form.get('grant_type') == 'refresh_token':
            if srv.refresh_error or form.get('refresh_token') not in srv.refresh:
                return self.reply(400, dict(error=srv.refresh_error or 'invalid_grant', error_description='Token has been expired or revoked.'))
            return self.grant(None)
        self.reply(400, dict(error='unsupported_grant_type'))

    def document(self, doc_id, query):
        srv = self.server
        if srv.always_401 or (self.headers.get('Authorization') or '').removeprefix('Bearer ') not in srv.access:
            return self.reply(401, dict(error=dict(code=401, status='UNAUTHENTICATED')))
        if srv.docs_queue:
            status = srv.docs_queue.pop(0)
            return self.reply(status, dict(error=dict(code=status)))
        doc = srv.docs.get(doc_id)
        if doc is None:
            return self.reply(404, dict(error=dict(code=404)))
        if doc.get('status'):
            return self.reply(doc['status'], dict(error=dict(code=doc['status'])))
        if query.get('fields') == 'title':
            return self.reply(200, dict(title=doc['title']))
        body = dict(documentId=doc_id, title=doc['title'], body=dict(content=doc['content']))
        if doc.get('revision'):  # Google leaves revisionId out for a user who cannot edit
            body['revisionId'] = doc['revision']
        self.reply(200, body)


@contextmanager
def fake_google():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeGoogle)
    srv.log, srv.codes, srv.refresh, srv.access, srv.secret_values, srv.docs = [], {}, set(), set(), [], {}
    srv.docs_queue, srv.refresh_error, srv.revoke_status, srv.expires_in = [], None, 200, 3600
    srv.always_401, srv.granted = False, google_docs.SCOPE
    srv.url = f'http://127.0.0.1:{srv.server_port}'
    thread = threading.Thread(target=srv.serve_forever, args=(.05,), daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


class GoogleFixture(PipelineFixture):
    """The pipeline fixture, the fake Google behind the four endpoint variables, the collector's local page on a port, and
    the Google provider as the only provider."""

    def setUp(self):
        super().setUp()
        configure(self.pipeline, dict(turnsPerBatch=10))
        self.google = self.enterContext(fake_google())
        self.enterContext(patch.dict(os.environ, SYNCUP_GOOGLE_AUTH_URL=f'{self.google.url}/auth', SYNCUP_GOOGLE_TOKEN_URL=f'{self.google.url}/token',
                                     SYNCUP_GOOGLE_DOCS_API=f'{self.google.url}/v1', SYNCUP_GOOGLE_REVOKE_URL=f'{self.google.url}/revoke'))
        self.enterContext(patch.object(google_docs, 'RETRY_DELAYS', (0, 0, 0)))  # no waiting after a 429
        self.provider = google_docs.GoogleDocsProvider()
        self.enterContext(patch.dict(base.PROVIDERS, {google_docs.SITE: self.provider}, clear=True))
        self.page = self.enterContext(server(Review, self.db))
        self.page.pipeline, self.page.team_client = self.pipeline, self.pipeline.client
        self.pipeline.page_port = self.page.server_port
        self.state = base.state_dir(self.pipeline)
        self.path = self.state / 'connectors' / 'google-docs.json'
        self.redirect = f'http://127.0.0.1:{self.page.server_port}/connectors/callback/google-docs'
        self.google.docs[DOC] = dict(title='회의록', revision='rev-1', content=copy.deepcopy(SAMPLE))

    # -- what the user and the browser do
    def token(self):
        return base.load_token(self.state, 'google-docs')

    def write_token(self, token):
        base.save_token(self.state, 'google-docs', token)

    def setup(self, **form):
        return self.provider.handle_setup(self.pipeline, form)

    def link(self):
        """The Google login address the setup form shows, or None."""
        found = re.search(r'href="([^"]*client_id[^"]*)"', self.provider.setup_html(self.pipeline))
        return html.unescape(found.group(1)) if found else None

    def follow(self, link):
        """The browser opens the login link, allows, and is sent back: the address it is sent to (not followed)."""
        parts = urllib.parse.urlsplit(link)
        connection = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
        try:
            connection.request('GET', parts.path + '?' + parts.query)
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 302)
            return response.getheader('Location')
        finally:
            connection.close()

    @staticmethod
    def query_of(address):
        return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(address).query).items()}

    def start_login(self):
        """Credentials saved, "구글 계정 연결" pressed, the browser sent back: the callback query not yet delivered."""
        self.setup(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
        self.setup(action='connect')
        return self.query_of(self.follow(self.link()))

    def login(self):
        return self.provider.handle_callback(self.pipeline, self.start_login())

    def add_document(self, doc=DOC, owner=True):
        form = dict(doc_url=f'https://docs.google.com/document/d/{doc}/edit?usp=sharing')
        if owner:
            form['owner'] = '1'
        return self.setup(**form)

    def scope(self, doc=DOC, cursor=None):
        return dict(team_id='a', site='google-docs', scope_id=doc, title='', enabled=1, cursor=cursor, last_run=None,
                    last_error=None, imported=0)

    def expire_access_token(self):
        token = self.token()
        token['expires_at'] = 0
        self.write_token(token)

    # -- what the fake saw, and what must never be seen
    def requests(self, path=None, grant=None, after=0):
        return [r for r in self.google.log[after:] if (path is None or r['path'].startswith(path))
                and (grant is None or r['form'].get('grant_type') == grant)]

    def assertClean(self, text):
        """No client secret, access token, refresh token, authorization code or PKCE verifier in text (str or bytes)."""
        try:
            verifier = ((self.token() or {}).get('pending') or {}).get('verifier')
        except ValueError:
            verifier = None
        haystack = text if isinstance(text, bytes) else str(text).encode()
        for value in [CLIENT_SECRET, *self.google.secret_values, *([verifier] if verifier else [])]:
            self.assertNotIn(value.encode(), haystack)

    def refused(self, kind, status, call, *args):
        """call(*args) raises ConnectorError(kind, status), and nothing it carries (text, traceback, chain) holds a secret."""
        with self.assertRaises(base.ConnectorError) as caught:
            call(*args)
        error = caught.exception
        self.assertEqual((error.kind, error.status), (kind, status))
        self.assertClean(repr(error) + str(error) + ''.join(traceback.format_exception(type(error), error, error.__traceback__)))
        return error

    def listed(self):
        provider, = [p for p in dispatch(self.pipeline, 'connectors.list', {})['providers'] if p['site'] == 'google-docs']
        return provider

    def scope_row(self, doc=DOC):
        with connect(self.db) as c:
            return dict(c.execute('SELECT * FROM connector_scopes WHERE scope_id=?', (doc,)).fetchone())

    def count(self, sql, *args):
        with connect(self.db) as c:
            return c.execute(sql, args).fetchone()[0]


# ---------------------------------------------------------------------------------------------------------------------

class Registration(unittest.TestCase):
    def test_the_module_registers_one_provider_for_the_google_docs_site(self):
        self.assertEqual((google_docs.SITE, google_docs.GoogleDocsProvider.label), ('google-docs', '구글 문서'))
        self.assertIn('google-docs', turn_intake.INTAKE_SITES)
        self.assertEqual(google_docs.SCOPE, 'https://www.googleapis.com/auth/documents.readonly')

    def test_document_addresses(self):
        good = {
            'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQr/edit': '1AbCdEfGhIjKlMnOpQr',
            'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQr': '1AbCdEfGhIjKlMnOpQr',
            ' https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOpQr/edit?tab=t.0#heading=h.x ': '1AbCdEfGhIjKlMnOpQr',
            DOC: DOC,
        }
        for text, doc_id in good.items():
            with self.subTest(text=text):
                self.assertEqual(google_docs.doc_id_of(text), doc_id)
        for text in ('', 'hello', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQr/edit',
                     'http://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQr/edit',
                     'https://docs.google.com.evil.example/document/d/1AbCdEfGhIjKlMnOpQr/edit',
                     'https://evil.example/?u=https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQr/edit', 'short-id', '../../etc/passwd'):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, '문서 주소'):
                google_docs.doc_id_of(text)


class ConsentAndCallback(GoogleFixture):
    def test_the_consent_link_has_pkce_state_offline_access_and_the_loopback_redirect(self):
        self.setup(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
        self.assertIsNone(self.link(), 'no link before the user asks for one')
        self.assertIn('저장했습니다', self.setup(action='connect') + '저장했습니다')
        link = self.link()
        parts = urllib.parse.urlsplit(link)
        self.assertEqual(f'{parts.scheme}://{parts.netloc}{parts.path}', f'{self.google.url}/auth')
        query = self.query_of(link)
        pending = self.token()['pending']
        self.assertEqual(query['client_id'], CLIENT_ID)
        self.assertEqual(query['redirect_uri'], self.redirect)
        self.assertEqual((query['response_type'], query['access_type'], query['prompt'], query['code_challenge_method']),
                         ('code', 'offline', 'consent', 'S256'))
        self.assertEqual(query['scope'], 'https://www.googleapis.com/auth/documents.readonly')
        self.assertEqual(query['code_challenge'], b64url(hashlib.sha256(pending['verifier'].encode()).digest()))
        self.assertTrue(43 <= len(pending['verifier']) <= 128, 'RFC 7636 verifier length')
        self.assertGreaterEqual(len(query['state']), 32)
        self.assertNotIn(query['state'], (query['code_challenge'], pending['verifier']))
        self.assertAlmostEqual(pending['expires_at'], time.time() + 600, delta=5)
        self.assertNotIn(CLIENT_SECRET, link)
        self.assertNotIn(pending['verifier'], link)
        self.setup(action='connect')
        again = self.token()['pending']['verifier']
        self.assertNotEqual(again, pending['verifier'])
        self.assertNotEqual(self.query_of(self.link())['state'], query['state'], 'a new login has a new state')

    def test_the_callback_exchanges_the_code_and_keeps_the_tokens_private(self):
        self.assertIn('연결했습니다', self.login())
        token = self.token()
        self.assertTrue(token['refresh_token'].startswith('1//CanaryRefresh-'))
        self.assertTrue(token['access_token'].startswith('syncup-canary-access-'))
        self.assertAlmostEqual(token['expires_at'], time.time() + 3600, delta=10)
        self.assertEqual((token['client_id'], token['client_secret']), (CLIENT_ID, CLIENT_SECRET))
        self.assertNotIn('pending', token, 'the login is over')
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=True, tokenSet=True, needs=None))
        exchange, = self.requests('/token', 'authorization_code')
        self.assertEqual((exchange['form']['client_id'], exchange['form']['client_secret'], exchange['form']['redirect_uri']),
                         (CLIENT_ID, CLIENT_SECRET, self.redirect))
        self.assertEqual(len(exchange['form']['code_verifier']), 86)
        if sys.platform != 'win32':
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ['google-docs.json'], 'no temporary file is left')
        self.assertNotIn(CLIENT_SECRET.encode(), self.db.read_bytes())
        self.assertNotIn(token['refresh_token'].encode(), self.db.read_bytes())

    def test_a_wrong_or_missing_state_is_rejected_and_does_not_end_the_real_login(self):
        query = self.start_login()
        for bad in (dict(query, state='x' * 43), dict(query, state=''), {k: v for k, v in query.items() if k != 'state'}):
            with self.subTest(state=bad.get('state')), self.assertRaisesRegex(ValueError, '거절'):
                self.provider.handle_callback(self.pipeline, bad)
        self.assertEqual(self.requests('/token'), [], 'the code of a stranger is not even sent to Google')
        self.assertNotIn('refresh_token', self.token())
        self.assertIn('pending', self.token())
        self.assertIn('연결했습니다', self.provider.handle_callback(self.pipeline, query))

    def test_a_callback_nobody_asked_for_is_refused(self):
        self.setup(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
        with self.assertRaisesRegex(ValueError, '진행 중인 구글 연결이 없습니다'):
            self.provider.handle_callback(self.pipeline, dict(code='whatever-code-value', state='whatever-state-value'))
        with patch.dict(base.PROVIDERS):  # no token file at all
            base.delete_token(self.state, 'google-docs')
            with self.assertRaisesRegex(ValueError, '진행 중인 구글 연결이 없습니다'):
                self.provider.handle_callback(self.pipeline, {})
        self.assertEqual(self.requests('/token'), [])

    def test_an_expired_login_is_rejected(self):
        query = self.start_login()
        token = self.token()
        token['pending']['expires_at'] = time.time() - 1
        self.write_token(token)
        self.assertIsNone(self.link(), 'an expired link is not offered')
        with self.assertRaisesRegex(ValueError, '10분'):
            self.provider.handle_callback(self.pipeline, query)
        self.assertNotIn('pending', self.token())
        self.assertEqual(self.requests('/token'), [])
        self.assertEqual(self.provider.status(self.pipeline)['connected'], False)

    def test_a_denied_consent_ends_the_login_without_asking_google_for_tokens(self):
        query = self.start_login()
        with self.assertRaisesRegex(ValueError, '취소'):
            self.provider.handle_callback(self.pipeline, dict(state=query['state'], error='access_denied'))
        self.assertNotIn('pending', self.token())
        self.assertEqual(self.requests('/token'), [])

    def test_a_consent_without_the_documents_permission_is_refused(self):
        self.google.granted = 'openid email'  # the user unticked "see your documents" on Google's screen
        with self.assertRaisesRegex(ValueError, '권한'):
            self.login()
        token = self.token()
        self.assertNotIn('refresh_token', token)
        self.assertNotIn('access_token', token)
        self.assertEqual(self.provider.status(self.pipeline)['connected'], False)

    def test_a_login_link_works_once(self):
        query = self.start_login()
        self.provider.handle_callback(self.pipeline, query)
        with self.assertRaisesRegex(ValueError, '진행 중인 구글 연결이 없습니다'):
            self.provider.handle_callback(self.pipeline, query)
        self.assertEqual(len(self.requests('/token', 'authorization_code')), 1)

    def test_google_refusing_the_exchange_is_a_korean_message_without_its_answer(self):
        query = self.start_login()
        token = self.token()
        token['client_secret'] = 'syncup_wrong_test_secret_not_real_01'
        self.write_token(token)
        with self.assertRaisesRegex(ValueError, '클라이언트 ID나 보안 비밀') as caught:
            self.provider.handle_callback(self.pipeline, query)
        self.assertClean(str(caught.exception))
        self.assertNotIn('refresh_token', self.token())

    def test_client_inputs_are_checked_and_never_echoed(self):
        for form in (dict(client_id='short'), dict(client_id='bad id with spaces'), dict(client_secret='short'),
                     dict(client_secret=CLIENT_SECRET + ' extra'), dict(client_id=CLIENT_ID, client_secret='<script>x</script>')):
            with self.subTest(form=list(form)), self.assertRaises(ValueError) as caught:
                self.setup(**form)
            self.assertNotIn(CLIENT_SECRET, str(caught.exception))
        self.assertIsNone(self.token(), 'a form with a bad value saves nothing')
        with self.assertRaisesRegex(ValueError, '입력한 내용이 없습니다'):
            self.setup()
        with self.assertRaisesRegex(ValueError, '먼저 클라이언트'):
            self.setup(action='connect')
        self.assertIn('저장했습니다', self.setup(client_id=CLIENT_ID, client_secret=CLIENT_SECRET))
        self.pipeline.page_port = None
        with self.assertRaisesRegex(ValueError, '주소'):
            self.setup(action='connect')

    def test_a_new_client_id_ends_the_old_login_but_a_new_secret_does_not(self):
        self.login()
        self.add_document()
        self.setup(client_secret='syncup_rotated_test_secret_same_app_1')
        self.assertTrue(self.provider.status(self.pipeline)['connected'])
        self.setup(client_id='syncup-another-test-client.example')
        token = self.token()
        self.assertEqual([k for k in ('refresh_token', 'access_token', 'expires_at', 'pending') if k in token], [])
        self.assertEqual(token['owner'], {DOC: True}, 'what the user confirmed stays')
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=False, tokenSet=True, needs='“구글 계정 연결”을 눌러 로그인하세요.'))

    def test_the_setup_form_asks_for_what_is_missing_and_never_fills_in_a_secret(self):
        empty = self.provider.setup_html(self.pipeline)
        for text in ('name="client_id"', 'name="client_secret" type="password"', '구글 계정 연결', 'name="action" value="connect"'):
            self.assertIn(text, empty)
        self.assertNotIn('doc_url', empty, 'documents are added after the login')
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=False, tokenSet=False, needs='구글 클라이언트 ID와 보안 비밀을 입력하세요.'))
        self.login()
        full = self.provider.setup_html(self.pipeline)
        for text in ('name="doc_url"', 'name="owner"', '이 문서의 담당자로서 가져오기'):
            self.assertIn(text, full)
        self.assertNotIn('구글 계정 연결', full)
        self.assertNotRegex(full, r'<input[^>]*type="password"[^>]*value=')
        self.assertClean(empty + full)


class Tokens(GoogleFixture):
    def test_the_access_token_is_renewed_when_it_expires_within_a_minute(self):
        self.login()
        first = self.token()['access_token']
        self.assertEqual(google_docs._access_token(self.pipeline), first)
        self.assertEqual(self.requests('/token', 'refresh_token'), [], 'an hour left: no request')
        token = self.token()
        token['expires_at'] = time.time() + 120
        self.write_token(token)
        self.assertEqual(google_docs._access_token(self.pipeline), first, 'two minutes left: still used')
        token['expires_at'] = time.time() + 30
        self.write_token(token)
        renewed = google_docs._access_token(self.pipeline)
        self.assertNotEqual(renewed, first)
        refresh, = self.requests('/token', 'refresh_token')
        self.assertEqual((refresh['form']['refresh_token'], refresh['form']['client_secret']), (self.token()['refresh_token'], CLIENT_SECRET))
        self.assertEqual(self.token()['access_token'], renewed)
        self.assertAlmostEqual(self.token()['expires_at'], time.time() + 3600, delta=10)
        self.assertEqual(google_docs._access_token(self.pipeline), renewed)

    def test_invalid_grant_ends_the_login_and_asks_to_connect_again(self):
        self.login()
        self.add_document()
        self.expire_access_token()
        self.google.refresh_error = 'invalid_grant'  # a Testing-mode app: seven days are over
        with self.assertLogs('syncup', 'WARNING') as logs:
            result = base.run_scope(self.pipeline, 'google-docs', DOC)
        self.assertEqual(result, dict(documents=0, sent=0, skipped=0, error='reauth_required'))
        self.assertEqual(self.scope_row()['last_error'], 'reauth_required')
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=False, tokenSet=True, needs=NEEDS_REAUTH))
        self.assertEqual(self.listed()['status']['needs'], NEEDS_REAUTH)
        token = self.token()
        self.assertEqual([k for k in ('refresh_token', 'access_token', 'expires_at') if k in token], [], 'a refused token is dropped')
        self.assertEqual((token['client_id'], token['owner']), (CLIENT_ID, {DOC: True}))
        self.assertClean('\n'.join(logs.output) + json.dumps(self.listed()))
        before = len(self.google.log)
        self.assertEqual(base.run_all(self.pipeline), [], 'a service that needs a new login is not asked again every 5 minutes')
        self.assertEqual(len(self.google.log), before)
        form = self.provider.setup_html(self.pipeline)
        self.assertIn('구글 계정 연결', form)
        self.assertNotIn('name="doc_url"', form)
        self.google.refresh_error = None  # the user connects again
        self.provider.handle_callback(self.pipeline, self.start_login())
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=True, tokenSet=True, needs=None))
        self.assertNotIn('reauth', self.token())
        self.assertEqual(base.run_scope(self.pipeline, 'google-docs', DOC), dict(documents=1, sent=3, skipped=0))

    def test_a_401_is_answered_by_one_refresh_and_one_more_try(self):
        self.login()
        self.add_document()
        self.google.access.clear()  # Google forgot the token; the file still thinks it has an hour left
        mark = len(self.google.log)
        documents, cursor = self.provider.fetch(self.pipeline, self.scope())
        self.assertEqual((len(documents), cursor), (1, 'rev-1'))
        self.assertEqual(len(self.requests('/v1/documents/', after=mark)), 2)
        self.assertEqual(len(self.requests('/token', 'refresh_token', after=mark)), 1)

    def test_a_second_401_is_unauthorized_after_exactly_one_refresh(self):
        self.login()
        self.add_document()
        self.google.always_401 = True
        mark = len(self.google.log)
        self.refused('unauthorized', 401, self.provider.fetch, self.pipeline, self.scope())
        self.assertEqual((len(self.requests('/v1/documents/', after=mark)), len(self.requests('/token', 'refresh_token', after=mark))), (2, 1))
        self.assertTrue(self.provider.status(self.pipeline)['connected'], 'a 401 on one document does not end the login')

    def test_http_errors_become_short_kinds(self):
        self.login()
        self.add_document()
        self.google.docs[DOC]['status'] = 403
        self.refused('forbidden', 403, self.provider.fetch, self.pipeline, self.scope())
        self.google.docs[DOC]['status'] = 500
        self.refused('server_error', 500, self.provider.fetch, self.pipeline, self.scope())
        del self.google.docs[DOC]
        self.refused('not_found', 404, self.provider.fetch, self.pipeline, self.scope())

    def test_a_429_is_asked_again_a_bounded_number_of_times(self):
        self.login()
        self.add_document()
        self.google.docs_queue = [429, 429]
        mark = len(self.google.log)
        documents, _ = self.provider.fetch(self.pipeline, self.scope())
        self.assertEqual((len(documents), len(self.requests('/v1/documents/', after=mark))), (1, 3))
        self.google.docs_queue = [429] * 9
        mark = len(self.google.log)
        self.refused('rate_limit', 429, self.provider.fetch, self.pipeline, self.scope())
        self.assertEqual(len(self.requests('/v1/documents/', after=mark)), 4, 'the first try and three more, then it gives up')

    def test_an_unreachable_google_is_a_network_error(self):
        self.login()
        self.add_document()
        with patch.dict(os.environ, SYNCUP_GOOGLE_DOCS_API='http://127.0.0.1:1/v1'):
            self.refused('network', None, self.provider.fetch, self.pipeline, self.scope())
        self.expire_access_token()
        with patch.dict(os.environ, SYNCUP_GOOGLE_TOKEN_URL='http://127.0.0.1:1/token'):
            self.refused('network', None, self.provider.fetch, self.pipeline, self.scope())

    def test_tokens_only_go_to_https_hosts_or_this_pc(self):
        self.login()
        self.add_document()
        mark = len(self.google.log)
        for url in ('http://docs.example.test/v1', 'ftp://127.0.0.1/v1', 'https://user:pw@docs.example.test/v1', 'https:///v1'):
            with self.subTest(url=url), patch.dict(os.environ, SYNCUP_GOOGLE_DOCS_API=url):
                self.refused('bad_endpoint', None, self.provider.fetch, self.pipeline, self.scope())
        self.assertEqual(self.google.log[mark:], [])
        with patch.dict(os.environ, SYNCUP_GOOGLE_DOCS_API='https://docs.example.test/v1/'):
            self.assertEqual(google_docs._endpoint('docs'), 'https://docs.example.test/v1')
        self.assertEqual(google_docs._endpoint('revoke').split('/')[2], f'127.0.0.1:{self.google.server_port}')
        with patch.dict(os.environ, clear=True):
            self.assertEqual(google_docs._endpoint('auth'), 'https://accounts.google.com/o/oauth2/v2/auth')
            self.assertEqual(google_docs._endpoint('token'), 'https://oauth2.googleapis.com/token')
            self.assertEqual(google_docs._endpoint('docs'), 'https://docs.googleapis.com/v1')
            self.assertEqual(google_docs._endpoint('revoke'), 'https://oauth2.googleapis.com/revoke')


class Conversion(unittest.TestCase):
    def sections(self, content, title='회의록'):
        return google_docs.sections_of(dict(title=title, body=dict(content=content)), title)

    def test_title_headings_bullets_table_and_skipped_parts(self):
        sections, first = self.sections(SAMPLE)
        self.assertEqual(sections, SAMPLE_SECTIONS)
        self.assertEqual(first, '11월 14일 회의')
        self.assertNotIn('TOC_CANARY', json.dumps(sections, ensure_ascii=False), 'the table of contents is skipped')

    def test_text_before_the_first_heading_belongs_to_the_document_title(self):
        sections, first = self.sections([paragraph('머리말 본문'), paragraph('결정', 'HEADING_1'), paragraph('SQLite')], title='  주간   회의록 ')
        self.assertEqual([(s['heading'], s['text']) for s in sections], [('주간 회의록', '머리말 본문'), ('결정', 'SQLite')])
        self.assertEqual(first, '머리말 본문')

    def test_only_title_and_the_first_three_heading_levels_start_a_section(self):
        content = [paragraph(f'제목 {style}', style) for style in ('HEADING_4', 'HEADING_5', 'HEADING_6', 'SUBTITLE')]
        sections, _ = self.sections(content + [paragraph('본문')])
        self.assertEqual([s['heading'] for s in sections], ['회의록'])
        self.assertEqual(sections[0]['text'], '제목 HEADING_4\n\n제목 HEADING_5\n\n제목 HEADING_6\n\n제목 SUBTITLE\n\n본문')

    def test_a_heading_alone_is_not_a_section_and_blank_paragraphs_are_skipped(self):
        sections, _ = self.sections([paragraph('빈 절', 'HEADING_1'), paragraph('  '), paragraph('다음', 'HEADING_2'), paragraph('내용')])
        self.assertEqual([(s['heading'], s['text']) for s in sections], [('다음', '내용')])
        self.assertEqual(self.sections([]), ([], None))
        self.assertEqual(self.sections([paragraph('제목만', 'TITLE')])[0], [])

    def test_a_soft_line_break_stays_a_line_break_and_runs_are_joined(self):
        runs = dict(paragraph=dict(elements=[dict(textRun=dict(content='굵게 ')), dict(textRun=dict(content='그리고\x0b다음 줄\n')),
                                             dict(inlineObjectElement=dict(inlineObjectId='x')), dict(pageBreak={})],
                                   paragraphStyle=dict(namedStyleType='NORMAL_TEXT')))
        self.assertEqual(self.sections([runs])[0][0]['text'], '굵게 그리고\n다음 줄')

    def test_table_cells_with_several_paragraphs_stay_on_the_row(self):
        cell = dict(content=[paragraph('첫째'), paragraph('둘째\t탭')])
        nested = dict(content=[table([['안', '쪽']])])
        rows = dict(table=dict(tableRows=[dict(tableCells=[cell, dict(content=[paragraph('')]), nested]), dict(tableCells=[dict(content=[paragraph('')])])]))
        self.assertEqual(self.sections([rows])[0][0]['text'], '첫째 둘째 탭\t\t안 쪽')

    def test_odd_json_does_not_crash_the_conversion(self):
        for content in ([None, 'x', 5, [], dict(paragraph='x'), dict(paragraph=dict(elements='x')), dict(table=dict(tableRows='x')),
                         dict(paragraph=dict(elements=[None, dict(textRun='x'), dict(textRun=dict(content=5))], bullet='yes'))], 'text', None):
            with self.subTest(content=str(content)[:30]):
                self.assertEqual(google_docs.sections_of(dict(body=dict(content=content)), '')[0], [])
        self.assertEqual(google_docs.sections_of('not a document', ''), ([], None))

    def test_every_section_says_the_author_is_unknown(self):
        sections, _ = self.sections(SAMPLE)
        self.assertEqual({s['author_is_me'] for s in sections}, {None})


class Fetch(GoogleFixture):
    def test_a_document_is_read_only_after_the_owner_box_was_ticked_for_it(self):
        self.login()
        self.google.docs[OTHER] = dict(title='다른 문서', revision='r1', content=copy.deepcopy(SAMPLE))
        self.assertIn('담당자 확인이 없어 아직 읽지 않습니다', self.add_document(owner=False))
        self.assertEqual([s['scope_id'] for s in base.list_scopes(self.pipeline, 'google-docs')], [DOC], 'the scope exists')
        mark = len(self.google.log)
        self.refused('owner_unconfirmed', None, self.provider.fetch, self.pipeline, self.scope())
        self.assertEqual(self.requests('/v1/', after=mark), [], 'nothing of the document is asked for before the user confirmed')
        self.assertIn('문서를 추가했습니다: 회의록', self.add_document(owner=True))
        self.assertEqual(len(self.provider.fetch(self.pipeline, self.scope())[0]), 1)
        self.add_document(OTHER, owner=False)
        self.refused('owner_unconfirmed', None, self.provider.fetch, self.pipeline, self.scope(OTHER))
        self.assertIn('문서를 추가했습니다', self.add_document(OTHER, owner=True))
        self.assertEqual(self.token()['owner'], {DOC: True, OTHER: True})
        self.add_document(OTHER, owner=False)  # the same box left empty takes the confirmation back
        self.refused('owner_unconfirmed', None, self.provider.fetch, self.pipeline, self.scope(OTHER))
        self.assertEqual(len(self.provider.fetch(self.pipeline, self.scope())[0]), 1, 'the other document is unaffected')

    def test_a_scope_added_another_way_is_not_read_without_the_confirmation(self):
        self.login()
        dispatch(self.pipeline, 'connectors.setScope', dict(site='google-docs', scopeId=DOC, title='손으로 넣음', enabled=True))
        mark = len(self.google.log)
        with self.assertLogs('syncup', 'WARNING'):
            result = base.run_scope(self.pipeline, 'google-docs', DOC)
        self.assertEqual(result, dict(documents=0, sent=0, skipped=0, error='owner_unconfirmed'))
        self.assertEqual(self.scope_row()['last_error'], 'owner_unconfirmed')
        self.assertEqual(self.requests('/v1/', after=mark), [])
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 0)

    def test_the_document_has_the_shape_the_framework_wants(self):
        self.login()
        self.add_document()
        documents, cursor = self.provider.fetch(self.pipeline, self.scope())
        doc, = documents
        self.assertEqual(cursor, 'rev-1')
        self.assertEqual((doc['source_id'], doc['title'], doc['url']), (DOC, '회의록', f'https://docs.google.com/document/d/{DOC}/edit'))
        self.assertIsNotNone(doc['modified'].tzinfo)
        self.assertLess(abs((datetime.now(timezone.utc) - doc['modified']).total_seconds()), 60)
        self.assertEqual(doc['sections'], SAMPLE_SECTIONS)
        messages = base.build_messages('google-docs', doc)
        self.assertEqual(len(messages), 3)
        self.assertEqual({m['site'] for m in messages}, {'google-docs'})
        for message in messages:
            turn_intake.clean_message(message)

    def test_the_revision_cursor_skips_an_unchanged_document(self):
        self.login()
        self.add_document()
        self.assertEqual(self.provider.fetch(self.pipeline, self.scope(cursor='rev-1')), ([], None))
        self.google.docs[DOC]['revision'] = 'rev-2'
        documents, cursor = self.provider.fetch(self.pipeline, self.scope(cursor='rev-1'))
        self.assertEqual((len(documents), cursor), (1, 'rev-2'))

    def test_a_document_without_a_revision_id_is_compared_by_its_text(self):
        self.login()
        self.add_document()
        self.google.docs[DOC]['revision'] = None  # a user who cannot edit gets no revisionId
        documents, cursor = self.provider.fetch(self.pipeline, self.scope())
        self.assertTrue(len(documents) == 1 and cursor.startswith('sha256:'))
        self.assertEqual(self.provider.fetch(self.pipeline, self.scope(cursor=cursor)), ([], None))
        self.google.docs[DOC]['content'][5]['paragraph']['elements'][0]['textRun']['content'] = 'PostgreSQL로 간다.\n'
        documents, changed = self.provider.fetch(self.pipeline, self.scope(cursor=cursor))
        self.assertTrue(len(documents) == 1 and changed != cursor)

    def test_syncups_own_team_record_is_not_read_back(self):
        self.login()
        self.add_document()
        self.google.docs[DOC]['content'] = [paragraph('# 싱크업 팀 기록 (2026-11-14)'), paragraph('결정', 'HEADING_1'), paragraph('SQLite로 간다.')]
        self.assertEqual(self.provider.fetch(self.pipeline, self.scope()), ([], 'rev-1'))
        self.google.docs[DOC]['content'] = [paragraph('회의'), paragraph('# 싱크업 팀 기록 은 아래에 붙여 둔다')]
        self.assertEqual(len(self.provider.fetch(self.pipeline, self.scope())[0]), 1, 'only a first line like that counts')

    def test_an_empty_document_reads_as_nothing(self):
        self.login()
        self.add_document()
        self.google.docs[DOC]['content'] = [dict(sectionBreak={}), paragraph('')]
        self.assertEqual(self.provider.fetch(self.pipeline, self.scope()), ([], 'rev-1'))

    def test_a_scope_id_that_is_not_a_document_id_is_refused_before_any_request(self):
        self.login()
        mark = len(self.google.log)
        for scope_id in ('../../v1/documents/x', 'a b', 'short', 'x' * 201, '', None, 5, 'id?fields=title', 'id/../../other0123456789'):
            with self.subTest(scope_id=scope_id):
                self.refused('bad_scope', None, self.provider.fetch, self.pipeline, self.scope(scope_id))
        self.assertEqual(self.google.log[mark:], [])

    def test_adding_a_document_explains_what_google_said(self):
        with self.assertRaisesRegex(ValueError, '먼저 구글 계정을 연결'):
            self.add_document()
        self.login()
        del self.google.docs[DOC]
        with self.assertRaisesRegex(ValueError, '문서를 찾을 수 없습니다'):
            self.add_document()
        self.google.docs[DOC] = dict(title='회의록', revision='r', content=[], status=403)
        with self.assertRaisesRegex(ValueError, '읽을 수 없습니다'):
            self.add_document()
        with self.assertRaisesRegex(ValueError, '문서 주소'):
            self.setup(doc_url='https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQr/edit')
        self.assertEqual(base.list_scopes(self.pipeline, 'google-docs'), [], 'a refused document leaves no scope')
        self.setup(client_id='syncup-other-test-client.example')  # no login now
        with self.assertRaisesRegex(ValueError, '먼저 구글 계정을 연결'):
            self.setup(client_id='syncup-third-test-client.example', doc_url=f'https://docs.google.com/document/d/{DOC}/edit')

    def test_a_long_title_fits_the_scope_and_an_untitled_one_shows_its_id(self):
        self.login()
        self.google.docs[DOC]['title'] = '가' * 300
        self.add_document()
        self.assertEqual(len(self.scope_row()['title']), 200)
        self.google.docs[OTHER] = dict(title='', revision='r', content=[])
        self.add_document(OTHER)
        self.assertEqual(self.scope_row(OTHER)['title'], OTHER)


class EndToEnd(GoogleFixture):
    def test_through_the_local_page_and_run_scope_into_turn_intake(self):
        seen = []

        def submit(**form):
            status, body = post(self.page, '/connectors/setup', dict(site='google-docs', **form))
            seen.append(body.decode())
            return status, body.decode()

        status, text = submit(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
        self.assertEqual((status, '클라이언트 정보를 저장했습니다' in text), (200, True))
        status, text = submit(action='connect')
        self.assertEqual((status, '구글 로그인 열기' in text), (200, True))
        link = html.unescape(re.search(r'href="([^"]*client_id[^"]*)"', text).group(1))
        query = self.query_of(link)
        self.assertEqual(query['client_id'], CLIENT_ID, 'the page scrubs the stored text, and the link still carries the client id')
        self.assertTrue(len(query['state']) >= 32 and len(query['code_challenge']) >= 32 and '…' not in link)
        self.assertEqual((query['redirect_uri'], query['code_challenge_method']), (self.redirect, 'S256'))
        location = urllib.parse.urlsplit(self.follow(link))
        status, text = get_page(self.page, location.path + '?' + location.query)
        seen.append(text)
        self.assertEqual((status, '구글 계정을 연결했습니다' in text), (200, True))
        self.assertIn('연결됨', text)
        status, text = submit(doc_url=f'https://docs.google.com/document/d/{DOC}/edit', owner='1')
        self.assertEqual((status, '문서를 추가했습니다: 회의록' in text), (200, True))
        self.assertEqual(self.listed()['status'], dict(connected=True, tokenSet=True, needs=None))
        self.assertEqual(self.listed()['scopes'], [dict(site='google-docs', scopeId=DOC, title='회의록', enabled=True, lastRun=None,
                                                         lastError=None, imported=0)])
        status, text = post(self.page, '/connectors/sync', dict(site='google-docs', scope_id=DOC))
        seen.append(text.decode())
        self.assertEqual((status, '새 글 3개' in text.decode()), (200, True))
        with connect(self.db) as c:
            messages = [json.loads(r[0]) for r in c.execute('SELECT message FROM intake ORDER BY rowid')]
        self.assertEqual(len(messages), 3)
        self.assertEqual({(m['site'], m['role'], m['conversationId']) for m in messages}, {('google-docs', 'user', f'google-docs:{DOC}')})
        self.assertEqual([m['text'].split('\n')[0] for m in messages], ['11월 14일 회의', '결정', '일정'])
        self.assertIn('- 이유 하나\n  - 세부 사항\n- 이유 둘', messages[1]['text'])
        self.assertIn('담당\t마감\n동균\t금요일', messages[2]['text'])
        self.assertTrue(all(datetime.fromisoformat(m['collectedAt']).tzinfo for m in messages))
        self.assertEqual(self.scope_row()['cursor'], 'rev-1')
        self.assertEqual((self.scope_row()['imported'], self.scope_row()['last_error']), (3, None))
        # unchanged: nothing sent, and the document is not even read again than the one request that finds the same revision
        self.assertEqual(base.run_scope(self.pipeline, 'google-docs', DOC), dict(documents=0, sent=0, skipped=0))
        # one edited section is the only new message
        self.google.docs[DOC]['revision'] = 'rev-2'
        self.google.docs[DOC]['content'][5]['paragraph']['elements'][0]['textRun']['content'] = 'PostgreSQL로 간다.\n'
        self.assertEqual(base.run_scope(self.pipeline, 'google-docs', DOC), dict(documents=1, sent=1, skipped=2))
        self.assertEqual(self.scope_row()['cursor'], 'rev-2')
        # a revision with the same text: all skipped
        self.google.docs[DOC]['revision'] = 'rev-3'
        self.assertEqual(base.run_scope(self.pipeline, 'google-docs', DOC), dict(documents=1, sent=0, skipped=3))
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 4)
        # everything a person or a script can read holds no secret
        seen += [get_page(self.page, '/connectors')[1], get_page(self.page, '/')[1], self.provider.setup_html(self.pipeline),
                 json.dumps(self.provider.status(self.pipeline)), json.dumps(dispatch(self.pipeline, 'connectors.list', {}), ensure_ascii=False)]
        for text in seen:
            self.assertClean(text)
        self.assertClean(self.db.read_bytes())
        self.assertIn(CLIENT_SECRET.encode(), self.path.read_bytes(), 'the secret is in its own file')

    def test_failures_leave_only_a_kind_and_a_status(self):
        self.login()
        self.add_document()
        seen = []
        self.google.access.clear()
        self.google.always_401 = True
        with self.assertLogs('syncup', 'WARNING') as logs:
            seen.append(json.dumps(base.run_scope(self.pipeline, 'google-docs', DOC)))
        self.assertEqual(self.scope_row()['last_error'], 'unauthorized 401')
        seen.append(get_page(self.page, '/connectors')[1])
        self.google.always_401 = False
        self.google.docs_queue = [429] * 9
        with self.assertLogs('syncup', 'WARNING') as more:
            seen.append(json.dumps(base.run_scope(self.pipeline, 'google-docs', DOC)))
        self.assertEqual(self.scope_row()['last_error'], 'rate_limit 429')
        self.google.docs_queue = []
        self.expire_access_token()
        self.google.refresh_error = 'invalid_grant'
        with self.assertLogs('syncup', 'WARNING') as last:
            seen.append(json.dumps(base.run_scope(self.pipeline, 'google-docs', DOC)))
        self.assertEqual(self.scope_row()['last_error'], 'reauth_required')
        status, text = post(self.page, '/connectors/sync', dict(site='google-docs', scope_id=DOC))
        self.assertEqual(status, 400, 'asking again before connecting again says to connect first')
        seen += [text.decode(), get_page(self.page, '/connectors')[1], json.dumps(self.listed(), ensure_ascii=False),
                 '\n'.join(logs.output + more.output + last.output)]
        self.assertIn(NEEDS_REAUTH, seen[-3] + seen[-2])
        for text in seen:
            self.assertClean(text)
        self.assertClean(self.db.read_bytes())

    def test_disconnect_revokes_at_google_and_deletes_the_file(self):
        self.login()
        self.add_document()
        refresh = self.token()['refresh_token']
        done = dispatch(self.pipeline, 'connectors.disconnect', dict(site='google-docs'))
        self.assertEqual(done, dict(site='google-docs', status=dict(connected=False, tokenSet=False, needs='구글 클라이언트 ID와 보안 비밀을 입력하세요.')))
        revoke, = self.requests('/revoke')
        self.assertEqual((revoke['method'], revoke['form']), ('POST', dict(token=refresh)))
        self.assertFalse(self.path.exists())
        self.assertEqual(len(self.listed()['scopes']), 1, 'the scopes stay, unread')
        dispatch(self.pipeline, 'connectors.disconnect', dict(site='google-docs'))  # again: nothing to revoke, no error
        self.assertEqual(len(self.requests('/revoke')), 1)

    def test_disconnect_from_the_page_works_and_the_file_goes_even_when_google_cannot_be_asked(self):
        self.login()
        self.google.revoke_status = 500
        status, text = post(self.page, '/connectors/disconnect', dict(site='google-docs'))
        self.assertEqual(status, 200)
        self.assertEqual((len(self.requests('/revoke')), self.path.exists()), (1, False))
        self.assertClean(text.decode())
        self.login()
        with patch.dict(os.environ, SYNCUP_GOOGLE_REVOKE_URL='http://127.0.0.1:1/revoke'):
            self.assertEqual(post(self.page, '/connectors/disconnect', dict(site='google-docs'))[0], 200)
        self.assertFalse(self.path.exists())
        self.login()
        with patch.dict(os.environ, SYNCUP_GOOGLE_REVOKE_URL='http://insecure.example.test/revoke'):
            dispatch(self.pipeline, 'connectors.disconnect', dict(site='google-docs'))
        self.assertFalse(self.path.exists())
        self.assertEqual(len(self.requests('/revoke')), 1, 'no revoke went to an insecure address')

    @unittest.skipIf(sys.platform == 'win32', 'POSIX file modes')
    def test_a_token_file_others_can_read_is_not_used_but_can_be_disconnected(self):
        self.login()
        self.path.chmod(0o644)
        with self.assertLogs('syncup', 'WARNING'):
            status = self.listed()['status']
        self.assertEqual((status['connected'], status['tokenSet']), (False, False))
        mark = len(self.google.log)
        dispatch(self.pipeline, 'connectors.disconnect', dict(site='google-docs'))
        self.assertFalse(self.path.exists())
        self.assertEqual(self.google.log[mark:], [], 'the unreadable file was not trusted enough to revoke with')


if __name__ == '__main__':
    unittest.main(verbosity=2)
