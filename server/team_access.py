"""Team row access: the restricted DB role, one transaction per authorized request and the per-team write lock."""
from contextlib import contextmanager
import hashlib
import re

import psycopg
from psycopg.rows import dict_row

# Connect and statement limit of API transactions: a stalled database answers 503 within the 10-second request timeout.
DB_TIMEOUT_SECONDS = 5
TOKEN_PATTERN = re.compile(r'[A-Za-z0-9_-]{43}')  # secrets.token_urlsafe(32), as team_admin.py issues them
REQUIRED_TABLES = ('users', 'teams', 'memberships', 'shared_cards', 'record_states',
                   'conflict_checks', 'conflicts', 'conflict_events', 'todo_states')
# conflict_checks columns that team_upgrades.sql adds, with what each one records
UPGRADE_COLUMNS = {'diagnostics': '진단 기록', 'progress': '검사 진행'}


class AccessError(Exception):
    def __init__(self, status):
        self.status = status


class DatabaseSetupError(ValueError):
    """A fixed operator hint that never contains connection details, so it is safe to print."""


def valid_token(token):
    return bool(TOKEN_PATTERN.fullmatch(token))


def verify_database(dsn):
    """Refuse to serve unless the API role is restricted, RLS is forced and the upgrades are applied."""
    with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=DB_TIMEOUT_SECONDS) as c:
        role = c.execute('SELECT * FROM pg_roles WHERE rolname=current_user').fetchone()
        if not _restricted(c, role):
            raise DatabaseSetupError('팀 API는 권한이 제한된 syncup_api DB 계정으로 실행해야 합니다.')
        tables = c.execute("""SELECT relname,relowner,relrowsecurity,relforcerowsecurity
            FROM pg_class WHERE relnamespace='syncup'::regnamespace AND relkind='r' AND relname = ANY(%s)""",
            (list(REQUIRED_TABLES),)).fetchall()
        if len(tables) != len(REQUIRED_TABLES) or any(t['relowner'] == role['oid'] or not t['relrowsecurity']
                                                      or not t['relforcerowsecurity'] for t in tables):
            raise DatabaseSetupError('팀 데이터베이스의 행 접근 정책 설정을 확인하세요.')
        for column, purpose in UPGRADE_COLUMNS.items():
            if not c.execute("""SELECT 1 FROM pg_attribute
                WHERE attrelid='syncup.conflict_checks'::regclass AND attname=%s
                  AND atttypid='jsonb'::regtype AND attnotnull AND NOT attisdropped""", (column,)).fetchone():
                raise DatabaseSetupError(f'server/team_admin.py migrate-integration으로 {purpose} 스키마를 적용하세요.')


def _restricted(c, role):
    privileged = ('rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication')
    if role['rolname'] != 'syncup_api' or any(role[k] for k in privileged):
        return False
    return not c.execute('SELECT 1 FROM pg_auth_members WHERE member=%s', (role['oid'],)).fetchone()


@contextmanager
def authorized(dsn, token, team_id=None):
    """One transaction acting as the token's user; RLS limits it to `team_id`'s rows when given."""
    if not valid_token(token):
        raise AccessError(401)
    with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=DB_TIMEOUT_SECONDS) as c:
        c.execute("SELECT set_config('statement_timeout',%s,true)", (f'{DB_TIMEOUT_SECONDS}s',))
        # Preserve approval timestamps exactly even when the pooler defaults to rounded output.
        c.execute('SET LOCAL extra_float_digits = 3')
        user_id = c.execute('SELECT syncup.authenticate(%s) AS id',
                            (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()['id']
        if user_id is None:
            raise AccessError(401)
        c.execute("SELECT set_config('syncup.user_id',%s,true)", (str(user_id),))
        if team_id is not None:
            c.execute("SELECT set_config('syncup.team_id',%s,true)", (str(team_id),))
            if not c.execute('SELECT 1 FROM syncup.memberships WHERE team_id=%s', (team_id,)).fetchone():
                raise AccessError(403)
        yield c, str(user_id)


def team_lock(c, team_id):
    """Serialize one team's writes until the transaction ends; every write path takes it first."""
    c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (str(team_id),))
