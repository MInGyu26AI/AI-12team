"""GitHub signup and team creation without a collector or a privileged DB connection.

The short-lived credential has no card/invite/collector privileges. Supabase tokens are discarded here.
The web BFF stores only our opaque credential in an HttpOnly cookie.
"""
import base64
import binascii
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
    'consent_required': (403, '먼저 이용약관과 개인정보 처리방침에 동의해 주세요.'),
    'consent_outdated': (409, '약관이 바뀌었어요. 화면을 새로고침해 다시 확인해 주세요.'),
    'name_mismatch': (400, '이름이 맞지 않아요. 지금 이름을 그대로 입력해 주세요.'),
    'blocked': (409, '다른 기록이 남아 있어 탈퇴를 마치지 못했어요. 문의처로 요청해 주세요.'),
    'keep': (409, '이미 동의했거나 팀이 있는 계정은 여기서 지울 수 없어요. 문의처로 요청해 주세요.'),
}
# The only place the current documents are named. A new version makes every account consent again (GET consent=null).
TERMS_VERSION = PRIVACY_VERSION = 'beta-0.1'
FUNCTIONS = ('syncup.open_onboarding(text,text,text,text)', 'syncup.onboarding_account(text)',
             'syncup.onboarding_create_team(text,uuid,text,text)', 'syncup.close_onboarding(text)',
             'syncup.onboarding_consent(text,text,text)', 'syncup.onboarding_decline(text)',
             'syncup.onboarding_profile(text)', 'syncup.onboarding_profile_save(text,text,text,text,text,text)',
             'syncup.onboarding_photo_set(text,text,bytea)', 'syncup.onboarding_withdraw(text,text)')
GRADES = ('1학년', '2학년', '3학년', '4학년', '5학년 이상', '대학원', '기타')
PHOTO_LIMIT = 300_000  # decoded bytes
PHOTO_BODY_LIMIT = 420_000  # request body for the photo path only: 300 KB as base64 plus the JSON wrapper
PHOTO_URL = re.compile(r'data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})')
PHOTO_PATH = '/onboarding/profile/photo'
PROFILE_PATHS = ('/onboarding/profile', PHOTO_PATH, '/onboarding/withdraw')
MAGIC = {'image/png': lambda b: b.startswith(b'\x89PNG\r\n\x1a\n'), 'image/jpeg': lambda b: b.startswith(b'\xff\xd8\xff'),
         'image/webp': lambda b: b[:4] == b'RIFF' and b[8:12] == b'WEBP'}


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


def account(c, token):
    result = answer(c.execute('SELECT syncup.onboarding_account(%s) AS v', (digest(token),)).fetchone()['v'])
    result['consent'] = next((item for item in result.pop('consents', [])
                              if item['terms'] == TERMS_VERSION and item['privacy'] == PRIVACY_VERSION), None)
    return result


def consent(c, token, data):
    if not isinstance(data, dict) or set(data) != {'terms', 'privacy', 'age14', 'transfer'} \
            or not all(isinstance(data[key], str) for key in ('terms', 'privacy')) \
            or data['age14'] is not True or data['transfer'] is not True:
        raise Rejected(400, '필수 항목 4개에 모두 동의해 주세요.')
    if (data['terms'], data['privacy']) != (TERMS_VERSION, PRIVACY_VERSION):
        raise Rejected(*ERRORS['consent_outdated'])
    answer(c.execute('SELECT syncup.onboarding_consent(%s,%s,%s) AS v',
                     (digest(token), TERMS_VERSION, PRIVACY_VERSION)).fetchone()['v'])
    return account(c, token)


def optional_text(value, maximum, label):
    """Single line, trimmed; None or blank means 'not set'."""
    if value is None:
        return None
    if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value) or len(value.strip()) > maximum:
        raise Rejected(400, f'{label}을(를) 확인해 주세요. (한 줄, {maximum}자 이하)')
    return value.strip() or None


def profile(c, token):
    result = answer(c.execute('SELECT syncup.onboarding_profile(%s) AS v', (digest(token),)).fetchone()['v'])
    photo, kind, subject = result.pop('photo_b64'), result.pop('photo_type'), result.pop('github_subject')
    result['photo'] = f'data:{kind};base64,{photo}' if photo and kind else None
    result['github_avatar'] = f'https://avatars.githubusercontent.com/u/{subject}?s=256' if subject else None
    return {key: result[key] for key in ('name', 'school', 'major', 'grade', 'role', 'photo', 'github_avatar', 'updated_at')}


def require_consent(c, token):
    if account(c, token)['consent'] is None:
        raise Rejected(*ERRORS['consent_required'])


def save_profile(c, token, data):
    require_consent(c, token)  # also the sign-in check: an unknown session is 401 whatever the body
    if not isinstance(data, dict) or set(data) != {'name', 'school', 'major', 'grade', 'role'}:
        raise Rejected(400, '이름·학교·전공·학년·역할을 보내 주세요.')
    name = checked_text(data['name'], 40, '이름을 확인해 주세요. (한 줄, 40자 이하)')
    school, major = optional_text(data['school'], 60, '학교'), optional_text(data['major'], 60, '전공')
    role = optional_text(data['role'], 80, '역할')
    grade = data['grade']
    if grade is not None and grade != '' and (not isinstance(grade, str) or grade not in GRADES):
        raise Rejected(400, '학년을 목록에서 골라 주세요.')
    answer(c.execute('SELECT syncup.onboarding_profile_save(%s,%s,%s,%s,%s,%s) AS v',
                     (digest(token), name, school, major, grade or None, role)).fetchone()['v'])
    return profile(c, token)


def save_photo(c, token, data):
    require_consent(c, token)
    bad = '사진은 PNG, JPEG, WebP 형식의 300KB 이하 파일이어야 해요.'
    if not isinstance(data, dict) or set(data) != {'image'} or not isinstance(data['image'], str):
        raise Rejected(400, bad)
    match = PHOTO_URL.fullmatch(data['image'])
    if not match:
        raise Rejected(400, bad)
    try:
        photo = base64.b64decode(match[2], validate=True)
    except (binascii.Error, ValueError):
        raise Rejected(400, bad) from None
    if not 12 <= len(photo) <= PHOTO_LIMIT or not MAGIC[match[1]](photo):
        raise Rejected(400, bad)
    answer(c.execute('SELECT syncup.onboarding_photo_set(%s,%s,%s) AS v', (digest(token), match[1], photo)).fetchone()['v'])
    return profile(c, token)


def withdraw(c, token, data):
    if not isinstance(data, dict) or set(data) != {'confirm'} or not isinstance(data['confirm'], str):
        raise Rejected(400, '지금 이름을 그대로 입력해 주세요.')
    return answer(c.execute('SELECT syncup.onboarding_withdraw(%s,%s) AS v',
                            (digest(token), data['confirm'].strip())).fetchone()['v'])


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
            return account(c, token)
        if path == '/onboarding/consent' and method == 'POST':
            return consent(c, token, data)
        if path == '/onboarding/decline' and method == 'POST':
            if data != {}:
                raise Rejected(400, '요청 내용을 확인해 주세요.')
            return answer(c.execute('SELECT syncup.onboarding_decline(%s) AS v', (digest(token),)).fetchone()['v'])
        if path == '/onboarding/profile' and method == 'GET':
            return profile(c, token)
        if path == '/onboarding/profile' and method == 'PUT':
            return save_profile(c, token, data)
        if path == PHOTO_PATH and method == 'PUT':
            return save_photo(c, token, data)
        if path == PHOTO_PATH and method == 'DELETE':
            answer(c.execute('SELECT syncup.onboarding_photo_set(%s,NULL,NULL) AS v', (digest(token),)).fetchone()['v'])
            return profile(c, token)
        if path == '/onboarding/withdraw' and method == 'POST':
            return withdraw(c, token, data)
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
            name = checked_text(data['name'], 80, '팀 이름을 확인해 주세요. (한 줄, 80자 이하)')
            topic = checked_text(data['topic'], 1200, '프로젝트 주제를 확인해 주세요. (1200자 이하)', multiline=True)
            if account(c, token)['consent'] is None:  # consent rows are never removed, so no race with the insert
                raise Rejected(*ERRORS['consent_required'])
            return answer(c.execute('SELECT syncup.onboarding_create_team(%s,%s,%s,%s) AS v',
                          (digest(token), request_id, name, topic)).fetchone()['v'])
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
        signed_in = authorization.startswith('Bearer ') and TOKEN.fullmatch(token) and (
            handler.path == '/onboarding' or handler.path == '/onboarding/profile' and handler.command == 'GET')
        if not (take_session(token) if signed_in and handler.command in ('GET', 'DELETE') else LIMIT.take()):
            raise Rejected(*ERRORS['limited'])
        data = None
        photo = handler.path == PHOTO_PATH
        if handler.command == 'POST' or handler.command == 'PUT' and handler.path in PROFILE_PATHS:
            try:
                data = json.loads(handler.body(PHOTO_BODY_LIMIT if photo else 8192))
            except (ValueError, TypeError):
                raise Rejected(400, '사진 크기를 확인해 주세요. (300KB 이하)' if photo
                               else '요청 내용을 확인해 주세요.') from None
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
    for name in ('onboarding_sessions', 'onboarding_teams', 'onboarding_consents', 'onboarding_profiles'):
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
