"""A loopback stand-in for Supabase Auth's PKCE login, for checks only: /auth/v1/authorize, /auth/v1/token?grant_type=pkce
and /auth/v1/logout, answering the way the hosted service does (supabase/auth internal/api/external.go, token.go).

A login is simulated with `login(challenge, user)` (or by opening /authorize with `next_user` set), which stands for
the user signing in at GitHub. Users are built with `github_user`; synthetic data only.
"""
import base64
from contextlib import contextmanager
import hashlib
import http.server
import json
import secrets
import threading
import time
import urllib.parse
import uuid

PUBLISHABLE_KEY = 'sb_publishable_' + 'F' * 24
PROVIDER_TOKEN = 'gho_FAKE_PROVIDER_TOKEN_DO_NOT_LOG'


def github_user(github_id, login, **changes):
    """A Supabase user signed in with GitHub; `changes` replace top-level fields (identities, user_metadata, …)."""
    user_id = str(uuid.uuid4())
    user = dict(id=user_id, aud='authenticated', role='authenticated', email=f'{login}@users.invalid',
                app_metadata=dict(provider='github', providers=['github']),
                user_metadata=dict(user_name=login, provider_id=str(github_id), sub=str(github_id)),
                identities=[dict(identity_id=str(uuid.uuid4()), id=str(github_id), user_id=user_id, provider='github',
                                 identity_data=dict(sub=str(github_id), provider_id=str(github_id), user_name=login))])
    user.update(changes)
    return user


def challenge_of(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()


def _part(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()


class FakeSupabase(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), _Handler)
        self.url = f'http://127.0.0.1:{self.server_port}'
        self.key = PUBLISHABLE_KEY
        self.flows = {}  # code -> dict(challenge, user, method, at)
        self.calls = []  # (method, path) of every request
        self.logged_out = []  # session ids
        self.sessions = {}  # session id -> user id
        self.next_user = None  # the user /authorize signs in
        self.failure = 0  # answer the token exchange with this status
        self.lock = threading.Lock()

    def login(self, challenge, user, method='oauth', age=0):
        """The code Supabase would send back after `user` signed in at GitHub for this PKCE challenge."""
        code = str(uuid.uuid4())
        with self.lock:
            self.flows[code] = dict(challenge=challenge, user=user, method=method, at=time.time() - age)
        return code

    def exchanges(self):
        return sum(1 for method, path in self.calls if path.startswith('/auth/v1/token'))


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, status, value=None):
        data = b'' if value is None else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.server.calls.append(('GET', self.path))
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        if (url.path != '/auth/v1/authorize' or query.get('provider') != 'github'
                or query.get('code_challenge_method') != 's256' or not query.get('code_challenge')
                or not query.get('redirect_to') or self.server.next_user is None):
            return self.answer(400, dict(error='bad authorize request'))
        code = self.server.login(query['code_challenge'], self.server.next_user)
        target = urllib.parse.urlsplit(query['redirect_to'])
        location = urllib.parse.urlunsplit(target._replace(query=urllib.parse.urlencode(dict(code=code))))
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        self.server.calls.append(('POST', self.path))
        if self.headers.get('apikey') != self.server.key:
            return self.answer(401, dict(error='no api key'))
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        if self.path == '/auth/v1/token?grant_type=pkce':
            return self.token(body)
        if self.path == '/auth/v1/logout?scope=local':
            bearer = self.headers.get('Authorization', '')
            claims = json.loads(base64.urlsafe_b64decode(bearer.split('.')[1] + '=='))
            self.server.logged_out.append(claims['session_id'])
            return self.answer(204)
        self.answer(404, dict(error='unknown path'))

    def token(self, body):
        if self.server.failure:
            return self.answer(self.server.failure, dict(error='synthetic failure'))
        with self.server.lock:
            flow = self.server.flows.get(body.get('auth_code'))
            if flow is None:
                return self.answer(404, dict(error_code='flow_state_not_found'))
            if time.time() - flow['at'] > 300:
                return self.answer(422, dict(error_code='flow_state_expired'))
            if challenge_of(str(body.get('code_verifier'))) != flow['challenge']:
                return self.answer(400, dict(error_code='bad_code_verifier'))
            del self.server.flows[body['auth_code']]  # a code is exchanged once
        user, session_id, now = flow['user'], str(uuid.uuid4()), int(time.time())
        self.server.sessions[session_id] = user['id']
        claims = dict(iss=self.server.url + '/auth/v1', sub=user['id'], aud='authenticated', exp=now + 3600, iat=now,
                      role='authenticated', aal='aal1', session_id=session_id,
                      amr=[dict(method=flow['method'], timestamp=now)])
        access = _part(dict(alg='ES256', typ='JWT')) + '.' + _part(claims) + '.' + secrets.token_urlsafe(16)
        self.answer(200, dict(access_token=access, token_type='bearer', expires_in=3600, expires_at=now + 3600,
                              refresh_token=secrets.token_urlsafe(12), user=user, provider_token=PROVIDER_TOKEN))


@contextmanager
def fake_supabase():
    srv = FakeSupabase()
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()
