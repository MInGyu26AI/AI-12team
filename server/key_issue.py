"""POST /keys: a teammate's GitHub login on the web becomes a team connection key, which never leaves their PC.

The PC's native host (collector/key_setup.py) holds the PKCE verifier of the login and generates the key; the browser
only carries Supabase's one-time code, which is useless without the verifier. The host sends the code, the verifier and
the SHA-256 of its new key here. This server exchanges the code with Supabase Auth itself, so no Supabase token reaches
the browser or the PC, takes the login provider's user IDs from Supabase's answer, and lets the database register the
digest only for a user the administrator linked those IDs to (team_upgrades.sql issue_web_key). It then signs that
Supabase session out. Off unless SYNCUP_SUPABASE_URL and SYNCUP_SUPABASE_PUBLISHABLE_KEY are set (docs/team-server.md).
"""
import base64
import collections
import hashlib
import http.client
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from diagnostics import failure
from secure_http import NoRedirect

PROVIDERS = ('github', 'google', 'kakao')  # Supabase providers a SyncUp identity can come from (identities table)
CODE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')  # Supabase PKCE auth codes are UUIDs
VERIFIER = re.compile(r'[A-Za-z0-9._~-]{43,128}')  # RFC 7636 code_verifier
DIGEST = re.compile(r'[0-9a-f]{64}')
DEVICES = ('macOS', 'Windows')
FIELDS = {'code', 'verifier', 'digest', 'device'}
BODY_LIMIT = 2048
RESPONSE_LIMIT = 64 * 1024
SUPABASE_SECONDS = 4  # per request; with the database (2 + 3 s) and sign-out (2 s) an issue ends within ~11 s
LOGOUT_SECONDS = 2
DB_CONNECT_SECONDS, DB_STATEMENT_SECONDS = 2, 3
# Every code exchange leaves from this server's one address, so keep well under Supabase's per-IP token limit.
WINDOW_SECONDS, WINDOW_LIMIT = 300, 60

ADMIN_CHECK = '관리자 확인이 필요한 계정입니다. 팀 관리자에게 GitHub 계정 등록을 요청하세요.'
LOG_IN_AGAIN = '로그인이 만료되었거나 이미 사용되었습니다. 처음부터 다시 로그인하세요.'
ANSWERS = {
    'unknown': (403, ADMIN_CHECK),
    'ambiguous': (403, ADMIN_CHECK),
    'inactive': (403, ADMIN_CHECK),
    'reused': (401, LOG_IN_AGAIN),
    'limited': (429, '잠시 뒤 다시 시도하세요.'),
    'full': (409, '연결된 PC가 너무 많습니다. 팀 관리자에게 이전 PC의 키 폐기를 요청하세요.'),
}
UNAVAILABLE = (503, '로그인 서버나 팀 저장소를 확인할 수 없습니다. 잠시 뒤 다시 시도하세요.')
JSON = 'application/json; charset=utf-8'


class Rejected(Exception):
    """An answer for the PC with a fixed message; never carries input or Supabase text."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class SettingError(ValueError):
    """A fixed message naming the setting, never its value; safe to print."""


def issuer_from_env(env=None):
    """The KeyIssuer for this deployment, or None when web keys are off. SettingError for a half or unsafe setting."""
    env = os.environ if env is None else env
    url, key = env.get('SYNCUP_SUPABASE_URL', ''), env.get('SYNCUP_SUPABASE_PUBLISHABLE_KEY', '')
    if not url and not key:
        return None
    if not url or not key:
        raise SettingError('SYNCUP_SUPABASE_URL과 SYNCUP_SUPABASE_PUBLISHABLE_KEY를 함께 지정하세요.')
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.supabase.co')
            or parsed.port or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise SettingError('SYNCUP_SUPABASE_URL은 https://<프로젝트>.supabase.co 형식이어야 합니다.')
    if not _publishable(key):
        raise SettingError('SYNCUP_SUPABASE_PUBLISHABLE_KEY에는 공개용(publishable 또는 anon) 키만 넣으세요.')
    return KeyIssuer(f'https://{parsed.hostname}', key)


def _publishable(key):
    """A publishable key, or a legacy anon key; never a secret or service_role key, which this server must not hold."""
    if re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]{8,200}', key):
        return True
    parts = key.split('.')
    if len(parts) != 3:
        return False
    try:
        return _decode_part(parts[1]).get('role') == 'anon'
    except ValueError:
        return False


def _decode_part(part):
    """The JSON object in one base64url JWT segment; ValueError otherwise."""
    try:
        value = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    except (ValueError, TypeError) as error:
        raise ValueError('JWT 형식') from error
    if not isinstance(value, dict):
        raise ValueError('JWT 형식')
    return value


class WindowLimit:
    """At most `limit` calls in any `seconds`-long window, across all clients."""

    def __init__(self, limit=WINDOW_LIMIT, seconds=WINDOW_SECONDS):
        self.limit, self.seconds, self.calls, self.lock = limit, seconds, collections.deque(), threading.Lock()

    def take(self):
        with self.lock:
            now = time.monotonic()
            while self.calls and now - self.calls[0] >= self.seconds:
                self.calls.popleft()
            if len(self.calls) >= self.limit:
                return False
            self.calls.append(now)
            return True


class KeyIssuer:
    def __init__(self, supabase_url, publishable_key, limit=None):
        self.url, self.key = supabase_url.rstrip('/'), publishable_key
        self.limit = limit or WindowLimit()

    def issue(self, dsn, data):
        """(status, response object) for one POST /keys body."""
        request = parse_request(data)
        replayed = self._replay(dsn, request['digest'])
        if replayed:
            return 200, replayed
        if not self.limit.take():
            raise Rejected(*ANSWERS['limited'])
        session = self._exchange(request['code'], request['verifier'])
        access = session.get('access_token')
        try:
            identities, session_hash = login_identities(session)
            return self._register(dsn, identities, session_hash, request)
        finally:
            # The answer above already holds; this only ends the Supabase session, whose tokens are dropped here.
            self._logout(access)

    def _supabase(self, path, body, bearer=None, seconds=SUPABASE_SECONDS):
        headers = {'apikey': self.key, 'Content-Type': 'application/json'}
        if bearer:
            headers['Authorization'] = 'Bearer ' + bearer
        call = urllib.request.Request(self.url + path, json.dumps(body).encode(), headers, method='POST')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(call, timeout=seconds) as response:
            return response.status, response.read(RESPONSE_LIMIT + 1)

    def _exchange(self, code, verifier):
        """Supabase's session for this PKCE login (access_token, user, …); Rejected when the code is not valid."""
        try:
            status, raw = self._supabase('/auth/v1/token?grant_type=pkce', dict(auth_code=code, code_verifier=verifier))
        except urllib.error.HTTPError as error:
            error.close()
            if error.code == 429:
                raise Rejected(*ANSWERS['limited']) from None
            if 400 <= error.code < 500:  # unknown, expired or used code, or a verifier that does not match it
                raise Rejected(401, LOG_IN_AGAIN) from None
            failure('web_key_exchange', error)
            raise Rejected(*UNAVAILABLE) from None
        except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
            failure('web_key_exchange', error)
            raise Rejected(*UNAVAILABLE) from None
        try:
            session = json.loads(raw) if status == 200 and len(raw) <= RESPONSE_LIMIT else None
        except ValueError:
            session = None
        if not isinstance(session, dict) or not isinstance(session.get('access_token'), str):
            failure('web_key_exchange', ValueError('unexpected answer'))
            raise Rejected(*UNAVAILABLE)
        return session

    def _logout(self, access):
        if not isinstance(access, str):
            return
        try:
            self._supabase('/auth/v1/logout?scope=local', {}, bearer=access, seconds=LOGOUT_SECONDS)
        except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
            failure('web_key_logout', error)

    def _replay(self, dsn, digest):
        try:
            with _connect(dsn) as c:
                row = c.execute('SELECT * FROM syncup.replay_web_key(%s)', (digest,)).fetchone()
        except psycopg.Error as error:
            failure('web_key_replay', error)
            raise Rejected(*UNAVAILABLE) from None
        return _issued(row) if row else None

    def _register(self, dsn, identities, session_hash, request):
        try:
            with _connect(dsn) as c:
                row = c.execute('SELECT * FROM syncup.issue_web_key(%s,%s,%s,%s,%s)',
                                (Jsonb(identities), session_hash, request['digest'], request.get('replaces'),
                                 request['device'])).fetchone()
        except psycopg.errors.UniqueViolation:  # the same login raced itself, or a digest that is already a key
            raise Rejected(401, LOG_IN_AGAIN) from None
        except psycopg.Error as error:
            failure('web_key_register', error)
            raise Rejected(*UNAVAILABLE) from None
        if row['o_outcome'] != 'issued':
            raise Rejected(*ANSWERS[row['o_outcome']])
        return 200, _issued(row)


def _connect(dsn):
    c = psycopg.connect(dsn, row_factory=dict_row, connect_timeout=DB_CONNECT_SECONDS)
    c.execute("SELECT set_config('statement_timeout',%s,false)", (f'{DB_STATEMENT_SECONDS}s',))
    return c


def _issued(row):
    return dict(user_id=str(row['o_user_id']), name=row['o_name'], expires_at=row['o_expires_at'].isoformat())


def parse_request(data):
    """The checked POST /keys fields; Rejected(400) for anything else, before Supabase or the database is asked."""
    if (not isinstance(data, dict) or not FIELDS <= set(data) <= FIELDS | {'replaces'}
            or not all(isinstance(v, str) for v in data.values())
            or not CODE.fullmatch(data['code']) or not VERIFIER.fullmatch(data['verifier'])
            or not DIGEST.fullmatch(data['digest']) or data['device'] not in DEVICES
            or ('replaces' in data and not DIGEST.fullmatch(data['replaces']))):
        raise Rejected(400, '요청 형식을 확인하세요.')
    return data


def login_identities(session):
    """([{provider, subject}], SHA-256 of the session id) of an OAuth login; Rejected otherwise.

    Identities come only from user.identities: their provider and their id, which Supabase sets from the provider's
    own user ID (GitHub's numeric ID). user_metadata and app_metadata are never read, because the user can change
    user_metadata, and the access token's claims only confirm the login method."""
    user = session.get('user')
    try:
        claims = _decode_part(session['access_token'].split('.')[1])
    except (IndexError, ValueError):
        raise Rejected(401, LOG_IN_AGAIN) from None
    if not isinstance(user, dict) or not isinstance(user.get('id'), str) or claims.get('sub') != user['id']:
        raise Rejected(401, LOG_IN_AGAIN)
    methods = claims.get('amr')
    if not isinstance(methods, list) or not any(isinstance(m, dict) and m.get('method') == 'oauth' for m in methods):
        raise Rejected(401, LOG_IN_AGAIN)
    session_id = claims.get('session_id')
    if not isinstance(session_id, str) or not session_id:
        raise Rejected(401, LOG_IN_AGAIN)
    identities = user.get('identities')
    if not isinstance(identities, list) or not identities:
        raise Rejected(403, ADMIN_CHECK)
    found = []
    for identity in identities:
        if (not isinstance(identity, dict) or identity.get('provider') not in PROVIDERS
                or identity.get('user_id') != user['id'] or not isinstance(identity.get('id'), str)
                or not 1 <= len(identity['id']) <= 128):
            raise Rejected(403, ADMIN_CHECK)
        found.append(dict(provider=identity['provider'], subject=identity['id']))
    return found, hashlib.sha256(session_id.encode()).hexdigest()


def handle(handler):
    """Answer POST /keys on a TeamHandler; 404 while web keys are off, as for any unknown path."""
    issuer = getattr(handler.server, 'key_issuer', None)
    if not handler.valid_host():
        return handler.reply(400, '{}', 'application/json')
    if issuer is None:
        return handler.reply(404, json.dumps({'error': '접근할 수 없거나 허용되지 않은 요청입니다.'}, ensure_ascii=False), JSON)
    if handler.command != 'POST':
        return handler.reply(405, json.dumps({'error': '요청 형식을 확인하세요.'}, ensure_ascii=False), JSON)
    try:
        try:
            data = json.loads(handler.body(BODY_LIMIT))
        except (ValueError, TypeError):
            raise Rejected(400, '요청 형식을 확인하세요.') from None
        status, result = issuer.issue(handler.server.dsn, data)
    except Rejected as rejected:
        status, result = rejected.status, {'error': rejected.message}
    handler.reply(status, json.dumps(result, ensure_ascii=False), JSON)
