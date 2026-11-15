"""Invite links: any active member makes a link to their team, and whoever opens it joins with a GitHub login on the web.

    POST /teams/{id}/invites                 a new link: its code, this once, and when it expires
    GET  /teams/{id}/invites                 the team's member count and its links of the last 7 days, never a code
    POST /teams/{id}/invites/{link}/revoke   stop a link at once
    POST /invites/preview                    {code} → the team name and expiry the join page shows; needs no key
    POST /keys with invite and name          key_issue.py: the login joins the link's team, then gets a web key

The code is 144 random bits made here; the database keeps only its SHA-256 (team_upgrades.sql invites), and no log,
diagnostic or other answer carries it. Codes travel in request bodies, never in a path the server could log. Every
change runs in a database function, which also fixes the 7-day validity, the member limit (8) and the open-link limit
(5). Off with the web keys (key_issue.issuer_from_env): a server that cannot issue keys could not finish a join.
"""
import hashlib
import json
import re
import secrets
import uuid

import psycopg
from psycopg.types.json import Jsonb

from diagnostics import failure
import key_issue
from key_issue import JSON, LOG_IN_AGAIN, UNAVAILABLE, Rejected
from team_access import AccessError

CODE = re.compile(r'[A-Za-z0-9_-]{24}')  # secrets.token_urlsafe(18)
NAME = re.compile(r'[^\x00-\x1f\x7f]{1,40}')  # a new member's name as the team sees it
PREVIEW_LIMIT = key_issue.WindowLimit(30, 60)  # previews of the whole server per minute; codes are not guessable
PREVIEW_BODY_LIMIT = 256

LINK_GONE = '초대 링크가 만료됐거나 회수됐어요. 팀원에게 새 링크를 받으세요.'
TEAM_FULL = '팀 인원이 가득 찼어요. 팀원에게 확인하세요.'
REMOVED = '이 팀에서 빠진 계정이에요. 다시 참여하려면 팀 관리자에게 문의하세요.'
# join_with_invite outcomes other than joined/member: (status, message, reason). The native host shows its own
# message for a reason it knows (collector/key_setup.py INVITE_ANSWERS) and the /keys message for the status otherwise.
REFUSED = {
    'unknown_link': (410, LINK_GONE, 'link'),
    'expired': (410, LINK_GONE, 'link'),
    'revoked': (410, LINK_GONE, 'link'),
    'team_full': (409, TEAM_FULL, 'team_full'),
    'removed': (403, REMOVED, 'removed'),
}


def code_hash(code):
    return hashlib.sha256(code.encode()).hexdigest()


def take_invite(data):
    """(the POST /keys body without its invite fields, {code_hash, name} or None). Both fields or neither."""
    if not isinstance(data, dict) or not {'invite', 'name'} & set(data):
        return data, None
    code, name = data.get('invite'), data.get('name')
    if not (isinstance(code, str) and CODE.fullmatch(code) and isinstance(name, str) and NAME.fullmatch(name.strip())):
        raise Rejected(400, '요청 형식을 확인하세요.')
    rest = {k: v for k, v in data.items() if k not in ('invite', 'name')}
    return rest, dict(code_hash=code_hash(code), name=name.strip())


def join(dsn, identities, session_hash, request, invite):
    """(200, {user_id, name, expires_at, team, added}) once the login is a member of the link's team with a new key."""
    try:
        with key_issue._connect(dsn) as c:
            row = c.execute('SELECT * FROM syncup.join_with_invite(%s,%s,%s,%s,%s,%s,%s)',
                            (invite['code_hash'], Jsonb(identities), session_hash, request['digest'],
                             request.get('replaces'), request['device'], invite['name'])).fetchone()
    except psycopg.errors.UniqueViolation:  # the same login raced itself, or one GitHub account joined two teams at once
        raise Rejected(401, LOG_IN_AGAIN) from None
    except psycopg.Error as error:
        failure('invite_join', error)
        raise Rejected(*UNAVAILABLE) from None
    outcome = row['o_outcome']
    if outcome in REFUSED:
        raise Rejected(*REFUSED[outcome])
    if outcome not in ('joined', 'member'):
        raise Rejected(*key_issue.ANSWERS[outcome])
    return 200, dict(user_id=str(row['o_user_id']), name=row['o_name'], expires_at=row['o_expires_at'].isoformat(),
                     team=row['o_team'], added=row['o_added'])


def team_request(c, team_id, method, tail, data):
    """GET/POST /teams/{id}/invites and POST …/invites/{link}/revoke, inside the member's authorized transaction."""
    if tail == ['invites'] and method == 'GET':
        listed = c.execute('SELECT syncup.list_invites(%s) AS v', (team_id,)).fetchone()['v']
        return dict(team_id=str(team_id), **listed)
    if tail == ['invites'] and method == 'POST' and data == {}:
        code = secrets.token_urlsafe(18)
        row = c.execute('SELECT * FROM syncup.create_invite(%s,%s)', (team_id, code_hash(code))).fetchone()
        if row['o_outcome'] == 'too_many':
            return dict(team_id=str(team_id), created=False)
        return dict(team_id=str(team_id), created=True, id=str(row['o_id']), code=code,
                    expires_at=row['o_expires_at'].isoformat())
    if len(tail) == 3 and tail[2] == 'revoke' and method == 'POST' and data == {}:
        found = c.execute('SELECT syncup.revoke_invite(%s,%s) AS found', (team_id, uuid.UUID(tail[1]))).fetchone()
        if not found['found']:
            raise AccessError(404)
        return dict(team_id=str(team_id), ok=True)
    raise AccessError(404)


def handle_preview(handler):
    """Answer POST /invites/preview on a TeamHandler: {status} and, for a usable link, its team and expiry."""
    if not handler.valid_host():
        return handler.reply(400, '{}', 'application/json')
    if getattr(handler.server, 'key_issuer', None) is None:
        return handler.reply(404, json.dumps({'error': '접근할 수 없거나 허용되지 않은 요청입니다.'}, ensure_ascii=False), JSON)
    if handler.command != 'POST':
        return handler.reply(405, json.dumps({'error': '요청 형식을 확인하세요.'}, ensure_ascii=False), JSON)
    try:
        try:
            data = json.loads(handler.body(PREVIEW_BODY_LIMIT))
        except (ValueError, TypeError):
            data = None
        if (not isinstance(data, dict) or set(data) != {'code'} or not isinstance(data['code'], str)
                or not CODE.fullmatch(data['code'])):
            raise Rejected(400, '요청 형식을 확인하세요.')
        if not PREVIEW_LIMIT.take():
            raise Rejected(*key_issue.ANSWERS['limited'])
        status, result = 200, preview(handler.server.dsn, data['code'])
    except Rejected as rejected:
        status, result = rejected.status, {'error': rejected.message}
    handler.reply(status, json.dumps(result, ensure_ascii=False), JSON)


def preview(dsn, code):
    try:
        with key_issue._connect(dsn) as c:
            row = c.execute('SELECT * FROM syncup.preview_invite(%s)', (code_hash(code),)).fetchone()
    except psycopg.Error as error:
        failure('invite_preview', error)
        raise Rejected(*UNAVAILABLE) from None
    if row['o_status'] != 'valid':
        return dict(status=row['o_status'])
    return dict(status='valid', team=row['o_team'], expires_at=row['o_expires_at'].isoformat(),
                members=row['o_members'], member_limit=row['o_member_limit'])


# team_upgrades.sql: the invite tables the API must not touch directly, and the functions it uses instead.
INVITE_TABLES = ('invites', 'invite_events')
INVITE_FUNCTIONS = ('syncup.create_invite(uuid,text)', 'syncup.list_invites(uuid)', 'syncup.revoke_invite(uuid,uuid)',
                    'syncup.preview_invite(text)', 'syncup.join_with_invite(text,jsonb,text,text,text,text,text)')


def invites_ready(c, role):
    """Like team_access._web_keys_ready: forced row security on the invite tables, no API privilege on them, and
    SECURITY DEFINER functions with a fixed search_path owned by a role that bypasses row security."""
    tables = c.execute("""SELECT relname FROM pg_class WHERE relnamespace='syncup'::regnamespace AND relkind='r'
        AND relname = ANY(%s) AND relrowsecurity AND relforcerowsecurity AND relowner<>%s""",
        (list(INVITE_TABLES), role['oid'])).fetchall()
    if len(tables) != len(INVITE_TABLES):
        return False
    for table in INVITE_TABLES:
        if c.execute("SELECT has_table_privilege(current_user, %s, 'SELECT,INSERT,UPDATE,DELETE') AS p",
                     ('syncup.' + table,)).fetchone()['p']:
            return False
    for signature in INVITE_FUNCTIONS:
        function = c.execute("""SELECT p.prosecdef, p.proconfig, o.rolsuper OR o.rolbypassrls AS owner_bypasses,
                has_function_privilege(current_user, p.oid, 'EXECUTE') AS callable
            FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=to_regprocedure(%s)""",
            (signature,)).fetchone()
        if not (function and function['prosecdef'] and function['owner_bypasses'] and function['callable']
                and 'search_path=pg_catalog, pg_temp' in (function['proconfig'] or [])):
            return False
    return True
