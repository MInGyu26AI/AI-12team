"""Authenticated, append-only team board; PostgreSQL enforces team row access."""
import argparse
from contextlib import contextmanager
import hashlib
import http.server
import json
import math
import os
import re
import time
import threading
import urllib.parse
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from secure_http import SecureHandler
from card_contract import validate_packet
from diagnostics import failure


class AccessError(Exception):
    def __init__(self, status):
        self.status = status


class TeamServer(http.server.ThreadingHTTPServer):
    request_queue_size = 32

    def __init__(self, *args, **kwargs):
        self.checks_stop = threading.Event()
        super().__init__(*args, **kwargs)

    def shutdown(self):
        self.checks_stop.set()
        super().shutdown()


def verify_database(dsn):
    with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=5) as c:
        role = c.execute("SELECT * FROM pg_roles WHERE rolname=current_user").fetchone()
        if (role['rolname'] != 'syncup_api' or any(role[k] for k in
                ('rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'))
                or c.execute("SELECT 1 FROM pg_auth_members WHERE member=%s", (role['oid'],)).fetchone()):
            raise ValueError('팀 API는 권한이 제한된 syncup_api DB 계정으로 실행해야 합니다.')
        tables = c.execute("""SELECT relname,relowner,relrowsecurity,relforcerowsecurity
            FROM pg_class WHERE relnamespace='syncup'::regnamespace AND relkind='r'
            AND relname IN ('users','teams','memberships','shared_cards','record_states','conflict_checks','conflicts','conflict_events','todo_states')""").fetchall()
        if len(tables) != 9 or any(t['relowner'] == role['oid'] or not t['relrowsecurity']
                                  or not t['relforcerowsecurity'] for t in tables):
            raise ValueError('팀 데이터베이스의 행 접근 정책 설정을 확인하세요.')
        if not c.execute("""SELECT 1 FROM pg_attribute
            WHERE attrelid='syncup.conflict_checks'::regclass AND attname='diagnostics'
              AND atttypid='jsonb'::regtype AND attnotnull AND NOT attisdropped""").fetchone():
            raise ValueError('team_admin.py migrate-integration으로 진단 기록 스키마를 적용하세요.')
        if not c.execute("""SELECT 1 FROM pg_attribute
            WHERE attrelid='syncup.conflict_checks'::regclass AND attname='progress'
              AND atttypid='jsonb'::regtype AND attnotnull AND NOT attisdropped""").fetchone():
            raise ValueError('team_admin.py migrate-integration으로 검사 진행 스키마를 적용하세요.')


@contextmanager
def authorized(dsn, token, team_id=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        raise AccessError(401)
    with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=5) as c:
        c.execute("SET LOCAL statement_timeout = '5s'")
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


class TeamHandler(SecureHandler):
    timeout = 10

    def do_GET(self):
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def do_PATCH(self):
        self.handle_api()

    def do_PUT(self):
        self.handle_api()

    def do_DELETE(self):
        self.handle_api()

    def handle_api(self):
        result, status = {}, 200
        token, team_id = '', None
        try:
            if not self.valid_host():
                raise AccessError(400)
            path = urllib.parse.urlsplit(self.path)
            if path.query or path.fragment:
                raise AccessError(404)
            parts = path.path.strip('/').split('/')
            if len(parts) >= 3 and parts[0] == 'teams':
                team_id = uuid.UUID(parts[1])
            elif parts != ['me']:
                raise AccessError(404)
            header = self.headers.get('Authorization', '')
            token = header[7:] if header.startswith('Bearer ') else ''
            if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                raise AccessError(401)
            data = json.loads(self.body()) if self.command == 'POST' else None
            with authorized(self.server.dsn, token, team_id) as (c, user_id):
                if parts == ['me'] and self.command == 'GET':
                    user = c.execute('SELECT name FROM syncup.users').fetchone()
                    teams = c.execute('SELECT id::text,name FROM syncup.teams ORDER BY name,id').fetchall()
                    result = dict(user_id=user_id, name=user['name'], teams=teams)
                elif team_id is not None and (parts[2] != 'items' or len(parts) == 5):
                    from team_records import handle
                    result = handle(c, team_id, user_id, self.command, parts[2:],
                                    data)
                elif team_id is not None and self.command == 'GET' and len(parts) in (3,4):
                    if len(parts) == 4:
                        card_id = urllib.parse.unquote(parts[3], errors='strict')
                        rows = c.execute('''SELECT packet,approved_by::text,approved_at
                            FROM syncup.shared_cards WHERE team_id=%s AND id=%s''', (team_id, card_id)).fetchall()
                        if not rows:
                            raise AccessError(404)
                    else:
                        rows = c.execute('''SELECT packet,approved_by::text,approved_at
                            FROM syncup.shared_cards WHERE team_id=%s ORDER BY received_at DESC,id LIMIT 200''',
                            (team_id,)).fetchall()
                    result = dict(team_id=str(team_id), items=rows)
                elif team_id is not None and len(parts) == 3 and self.command == 'POST':
                    from team_records import team_lock, enqueue
                    team_lock(c, team_id)
                    if not isinstance(data, dict) or set(data) != {'packet', 'approved_by', 'approved_at'}:
                        raise ValueError('Invalid envelope')
                    validate_packet(data['packet'])
                    if data['approved_by'] != user_id:
                        raise AccessError(403)
                    stamp = data['approved_at']
                    if type(stamp) not in (int, float) or not math.isfinite(stamp) or not 0 < stamp <= time.time()+300:
                        raise ValueError('Invalid approval time')
                    packet = data['packet']
                    c.execute('''INSERT INTO syncup.shared_cards(team_id,id,approved_by,approved_at,packet)
                        VALUES(%s,%s,%s,%s,%s) ON CONFLICT(team_id,id) DO NOTHING''',
                        (team_id, packet['id'], user_id, stamp, Jsonb(packet)))
                    saved = c.execute('''SELECT packet,approved_by::text,approved_at FROM syncup.shared_cards
                        WHERE team_id=%s AND id=%s''', (team_id, packet['id'])).fetchone()
                    if saved != data:
                        raise AccessError(409)
                    enqueue(c, team_id, packet)
                    result = dict(id=packet['id'], team_id=str(team_id), approved_by=user_id)
                else:
                    raise AccessError(405)
            # Respond only after the transaction has committed, including idempotent retries.
        except AccessError as error:
            status, result = error.status, {'error': '접근할 수 없거나 허용되지 않은 요청입니다.'}
        except (ValueError, TypeError, KeyError, UnicodeError, OverflowError):
            status, result = 400, {'error': '요청 형식을 확인하세요.'}
        except psycopg.errors.InsufficientPrivilege:
            status, result = 403, {'error': '이 작업에 대한 권한이 없습니다.'}
        except (psycopg.Error, OSError) as error:
            failure('team_api', error, team_id)
            status, result = 503, {'error': '팀 저장소를 확인할 수 없습니다.'}
        self.reply(status, json.dumps(result, ensure_ascii=False), 'application/json; charset=utf-8')
        if status == 200 and team_id is not None:
            from team_records import schedule
            schedule(self.server, token, team_id)


def main():
    from ai.syncup_ai.config import load_env
    load_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8878)
    args = parser.parse_args()
    if os.environ.get('SYNCUP_ADMIN_DATABASE_URL'):
        parser.error('팀 API 프로세스에서 SYNCUP_ADMIN_DATABASE_URL을 제거하세요.')
    dsn = os.environ.get('SYNCUP_DATABASE_URL')
    if not dsn:
        parser.error('SYNCUP_DATABASE_URL 환경 변수가 필요합니다.')
    try:
        verify_database(dsn)
    except (ValueError, psycopg.Error):
        parser.error('제한된 syncup_api 계정과 팀 DB 정책을 확인하세요.')
    with TeamServer(('127.0.0.1', args.port), TeamHandler) as srv:
        srv.dsn = dsn
        print(f'팀 API http://127.0.0.1:{srv.server_port}/ · 외부 연결은 HTTPS 프록시 필요', flush=True)
        srv.serve_forever()


if __name__ == '__main__':
    main()
