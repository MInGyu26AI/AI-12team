"""GitHub signup and team creation without a collector or a privileged DB connection.

The short-lived credential has no card/invite/collector privileges. Supabase tokens are discarded here.
The web BFF stores only our opaque credential in an HttpOnly cookie.
"""
import collections
import hashlib
import json
import re
import secrets
import threading
import uuid

import psycopg

from diagnostics import failure
import key_issue
from key_issue import Rejected

# Anonymous requests and POSTs share LIMIT. Signed-in reads/sign-out (one indexed lookup each) never touch it, so junk
# cannot starve the web gate's polling: each token gets its own window and all tokens share a larger cap (DB load).
LIMIT = key_issue.WindowLimit(120, 60)
SESSION_LIMIT = key_issue.WindowLimit(1200, 60)
PER_SESSION, MAX_SESSIONS = (30, 60), 4096
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
sessions, sessions_lock = collections.OrderedDict(), threading.Lock()


def take_session(token):
    with sessions_lock:
        key = digest(token)
        window = sessions.pop(key, None) or key_issue.WindowLimit(*PER_SESSION)
        sessions[key] = window
        while len(sessions) > MAX_SESSIONS:
            sessions.popitem(last=False)
    return window.take() and SESSION_LIMIT.take()
ERRORS = {
    'unauthorized': (401, '로그인 시간이 지났어요. GitHub로 다시 로그인해 주세요.'),
    'inactive': (403, '사용이 중지된 계정이에요.'),
    'reused': (401, '이미 사용한 로그인입니다. 다시 시작해 주세요.'),
    'limited': (429, '로그인 횟수가 많아요. 잠시 뒤 다시 시도해 주세요.'),
    'team_limit': (409, '직접 만들 수 있는 팀은 계정당 3개예요. 기존 팀으로 계속해 주세요.'),
    'request_conflict': (409, '이전 요청과 내용이 달라요. 화면을 새로고침해 주세요.'),
}
FUNCTIONS = ('syncup.open_onboarding(text,text,text,text)', 'syncup.onboarding_account(text)',
             'syncup.onboarding_create_team(text,uuid,text,text)', 'syncup.close_onboarding(text)')


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def checked_text(value, maximum, message='이름을 확인해 주세요.', multiline=False):
    if isinstance(value, str) and multiline:
        value = value.replace('\r\n', '\n').replace('\r', '\n')
    allowed = '\n\t' if multiline else ''
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum or any(
            (ord(c) < 32 and c not in allowed) or ord(c) == 127 for c in value):
        raise Rejected(400, message)
    return value.strip()


def answer(result):
    outcome = result.pop('outcome')
    if outcome in ERRORS:
        raise Rejected(*ERRORS[outcome])
    return result


def login(issuer, dsn, data):
    if not isinstance(data, dict) or not {'code', 'verifier'} <= data.keys() or data.keys() - {'code', 'verifier', 'name'}:
        raise Rejected(400, '로그인을 처음부터 다시 시작해 주세요.')
    if not (isinstance(data['code'], str) and key_issue.CODE.fullmatch(data['code'])
            and isinstance(data['verifier'], str) and key_issue.VERIFIER.fullmatch(data['verifier'])):
        raise Rejected(400, '로그인을 처음부터 다시 시작해 주세요.')
    # A provider display name is presentation only. Identity always comes from the verified numeric GitHub ID.
    name = checked_text(data['name'], 40) if 'name' in data else None
    if not issuer.limit.take():
        raise Rejected(*ERRORS['limited'])
    session = issuer._exchange(data['code'], data['verifier'])
    try:
        identities, login_hash = key_issue.login_identities(session)
        # Never attach by email or editable metadata. Self-service supports GitHub alone.
        if len(identities) != 1 or identities[0]['provider'] != 'github' or not re.fullmatch(r'[0-9]{1,20}', identities[0]['subject']):
            raise Rejected(403, 'GitHub 계정으로 로그인해 주세요.')
        if name is None:
            metadata = session.get('user', {}).get('user_metadata', {})
            metadata = metadata if isinstance(metadata, dict) else {}
            name = next((value.strip() for key in ('full_name', 'name', 'user_name', 'preferred_username')
                         if isinstance(value := metadata.get(key), str) and value.strip()
                         and len(value.strip()) <= 40 and not any(ord(c) < 32 or ord(c) == 127 for c in value)),
                        'GitHub 사용자')
        token = secrets.token_urlsafe(32)
        with key_issue._connect(dsn) as c:
            result = c.execute('SELECT syncup.open_onboarding(%s,%s,%s,%s) AS v',
                               (identities[0]['subject'], login_hash, digest(token), name)).fetchone()['v']
        return dict(answer(result), session=token, expires_in=1800)
    finally:
        issuer._logout(session.get('access_token'))


def dispatch(issuer, dsn, method, path, authorization, data):
    if path == '/onboarding/login' and method == 'POST':
        return login(issuer, dsn, data)
    token = authorization.removeprefix('Bearer ')
    if not authorization.startswith('Bearer ') or not TOKEN.fullmatch(token):
        raise Rejected(*ERRORS['unauthorized'])
    with key_issue._connect(dsn) as c:
        if path == '/onboarding' and method == 'GET':
            return answer(c.execute('SELECT syncup.onboarding_account(%s) AS v', (digest(token),)).fetchone()['v'])
        if path == '/onboarding' and method == 'DELETE':
            c.execute('SELECT syncup.close_onboarding(%s)', (digest(token),))
            return {'signed_out': True}
        if path == '/onboarding/teams' and method == 'POST':
            if not isinstance(data, dict) or set(data) != {'request_id', 'name', 'topic'}:
                raise Rejected(400, '팀 이름과 프로젝트 주제를 입력해 주세요.')
            try:
                request_id = uuid.UUID(data['request_id'])
            except (ValueError, TypeError, AttributeError):
                raise Rejected(400, '팀 생성 요청을 다시 시작해 주세요.') from None
            return answer(c.execute('SELECT syncup.onboarding_create_team(%s,%s,%s,%s) AS v',
                          (digest(token), request_id, checked_text(data['name'], 80, '팀 이름을 확인해 주세요. (한 줄, 80자 이하)'),
                           checked_text(data['topic'], 1200, '프로젝트 주제를 확인해 주세요. (1200자 이하)', multiline=True))).fetchone()['v'])
    raise Rejected(405, '지원하지 않는 요청이에요.')


def handle(handler):
    issuer = handler.server.key_issuer
    if not handler.valid_host():
        return handler.reply(400, '{}', key_issue.JSON)
    if issuer is None:
        return handler.reply(503, json.dumps({'error': 'GitHub 가입 준비 중이에요. 잠시 뒤 다시 방문해 주세요.'}), key_issue.JSON)
    try:
        authorization = handler.headers.get('Authorization', '')
        token = authorization.removeprefix('Bearer ')
        signed_in = authorization.startswith('Bearer ') and TOKEN.fullmatch(token) and handler.path == '/onboarding'
        if not (take_session(token) if signed_in and handler.command in ('GET', 'DELETE') else LIMIT.take()):
            raise Rejected(*ERRORS['limited'])
        data = None
        if handler.command == 'POST':
            try:
                data = json.loads(handler.body(8192))
            except (ValueError, TypeError):
                raise Rejected(400, '요청 내용을 확인해 주세요.') from None
        result = dispatch(issuer, handler.server.dsn, handler.command, handler.path,
                          handler.headers.get('Authorization', ''), data)
        status = 200
    except Rejected as error:
        status, result = error.status, {'error': error.message}
    except psycopg.errors.UniqueViolation:
        status, result = 409, {'error': '동시에 처리된 가입이 있어요. 다시 로그인해 주세요.'}
    except psycopg.Error as error:
        failure('onboarding', error)
        status, result = 503, {'error': '가입 정보를 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.'}
    handler.reply(status, json.dumps(result, ensure_ascii=False), key_issue.JSON)


def verify(c):
    from team_access import DatabaseSetupError
    hint = '셀프 가입 스키마를 적용하세요 (migrate-integration).'
    for name in ('onboarding_sessions', 'onboarding_teams'):
        table = c.execute('''SELECT relrowsecurity, relforcerowsecurity,
            has_table_privilege(current_user, oid, 'SELECT,INSERT,UPDATE,DELETE') AS direct
            FROM pg_class WHERE oid=to_regclass(%s)''', ('syncup.' + name,)).fetchone()
        if not table or not table['relrowsecurity'] or not table['relforcerowsecurity'] or table['direct']:
            raise DatabaseSetupError(hint)
    for signature in FUNCTIONS:
        row = c.execute('''SELECT p.prosecdef, p.proconfig, r.rolsuper OR r.rolbypassrls AS bypass,
            has_function_privilege(current_user,p.oid,'EXECUTE') AS callable
            FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure(%s)''',
            (signature,)).fetchone()
        if not row or not row['prosecdef'] or not row['bypass'] or not row['callable'] or 'search_path=pg_catalog, pg_temp' not in (row['proconfig'] or []):
            raise DatabaseSetupError(hint)
