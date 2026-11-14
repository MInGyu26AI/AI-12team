"""Authenticated, append-only team board API; PostgreSQL enforces team row access."""
import sys
from pathlib import Path

# 폴더별로 실행해도 contract/ 의 공용 모듈과 저장소 루트의 ai/ 를 찾는다
_REPO = Path(__file__).resolve().parents[1]
sys.path[1:1] = [str(_REPO / 'contract'), str(_REPO)]

import argparse
import http.server
import json
import os
import threading
import urllib.parse
import uuid

import psycopg

from conflict_checks import retry_check
from conflict_resolution import resolve
from conflict_scheduler import schedule
from diagnostics import failure
from repo_sync import first_check_due, linked, repo_status, schedule_save, target_from_env
from secure_http import SecureHandler
from team_access import AccessError, DatabaseSetupError, authorized, team_lock, valid_token, verify_database
from team_board import board, conflict_events, conflicts, done_todos, mark_todo, shared_item, shared_items
from team_publish import publish
from team_settings import settings_request

# GET /teams/{id}/<path>: the response fields after team_id.
BOARD_READS = {
    ('board',): lambda c, team_id: dict(items=board(c, team_id)),
    ('history',): lambda c, team_id: dict(items=board(c, team_id, history=True)),
    ('conflicts',): lambda c, team_id: dict(conflicts=conflicts(c, team_id)),
    ('conflicts', 'history'): lambda c, team_id: dict(conflicts=conflicts(c, team_id, history=True),
                                                      events=conflict_events(c, team_id)),
    ('todos', 'done'): lambda c, team_id: dict(ids=done_todos(c, team_id)),
}
# POST /teams/{id}/<kind>/{target}/<action> with a JSON object body.
CHANGES = {
    ('conflicts', 'resolve'): resolve,
    ('items', 'done'): mark_todo,
    ('items', 'retry-check'): lambda c, team_id, user_id, card_id, data: retry_check(c, team_id, card_id),
}


class TeamServer(http.server.ThreadingHTTPServer):
    request_queue_size = 32

    def __init__(self, *args, **kwargs):
        self.checks_stop = threading.Event()
        self.repo_target = None  # repo_sync.RepoTarget when one team's state is saved to GitHub
        super().__init__(*args, **kwargs)

    def shutdown(self):
        self.checks_stop.set()
        super().shutdown()


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
        status, result, token, team_id, actor = 200, {}, '', None, None
        try:
            parts, team_id = self.parse_path()
            token = self.bearer_token()
            data = json.loads(self.body()) if self.command == 'POST' else None
            with authorized(self.server.dsn, token, team_id) as (c, user_id):
                result = dispatch(c, user_id, team_id, self.command, parts, data, self.server)
                if self.command == 'POST' and linked(self.server, team_id):
                    actor = c.execute('SELECT name FROM syncup.users').fetchone()['name']  # own row only (RLS)
            # Respond only after the transaction has committed, including idempotent retries.
        except AccessError as error:
            status, result = error.status, {'error': '접근할 수 없거나 허용되지 않은 요청입니다.'}
        except (ValueError, TypeError, KeyError, OverflowError):
            status, result = 400, {'error': '요청 형식을 확인하세요.'}
        except psycopg.errors.InsufficientPrivilege:
            status, result = 403, {'error': '이 작업에 대한 권한이 없습니다.'}
        except (psycopg.Error, OSError) as error:
            failure('team_api', error, team_id)
            status, result = 503, {'error': '팀 저장소를 확인할 수 없습니다.'}
        self.reply(status, json.dumps(result, ensure_ascii=False), 'application/json; charset=utf-8')
        if status == 200 and team_id is not None:
            # No worker runs on its own: any member's successful team request resumes that team's due checks.
            schedule(self.server, token, team_id)
            self.save_repo_files(token, team_id, parts, actor)

    def save_repo_files(self, token, team_id, parts, actor):
        """A change is saved to the linked repository. After a start, the team's first request of any kind saves
        once right away, so a save that was waiting when the server stopped still happens and the status is known."""
        if self.command == 'POST':
            schedule_save(self.server, token, team_id, actor, approved=parts[2:] == ['items'])
        elif first_check_due(self.server, team_id):
            schedule_save(self.server, token, team_id, delay=0)

    def parse_path(self):
        """(path parts, team id or None for /me); checked before the token so unknown paths never touch the DB."""
        if not self.valid_host():
            raise AccessError(400)
        path = urllib.parse.urlsplit(self.path)
        if path.query or path.fragment:
            raise AccessError(404)
        parts = path.path.strip('/').split('/')
        if len(parts) >= 3 and parts[0] == 'teams':
            return parts, uuid.UUID(parts[1])
        if parts != ['me']:
            raise AccessError(404)
        return parts, None

    def bearer_token(self):
        # Checked again by authorized(); here it answers 401 before the body is read.
        header = self.headers.get('Authorization', '')
        token = header[7:] if header.startswith('Bearer ') else ''
        if not valid_token(token):
            raise AccessError(401)
        return token


def dispatch(c, user_id, team_id, method, parts, data, server=None):
    if team_id is None:
        if method != 'GET':
            raise AccessError(405)
        return me(c, user_id)
    tail = parts[2:]
    if tail[0] == 'items' and len(tail) != 3:
        return shared_cards(c, team_id, user_id, method, tail, data)
    if tail == ['settings']:
        return settings_request(c, team_id, user_id, method, data)
    if method == 'GET' and tail == ['repo']:
        return dict(team_id=str(team_id), repo=repo_status(server, team_id))
    if method == 'GET' and tuple(tail) in BOARD_READS:
        return dict(team_id=str(team_id), **BOARD_READS[tuple(tail)](c, team_id))
    change = CHANGES.get((tail[0], tail[2])) if len(tail) == 3 else None
    if method != 'POST' or not isinstance(data, dict) or change is None:
        raise AccessError(404)
    team_lock(c, team_id)
    change(c, team_id, user_id, path_id(tail[1]), data)
    return dict(ok=True, team_id=str(team_id))


def me(c, user_id):
    user = c.execute('SELECT name FROM syncup.users').fetchone()
    teams = c.execute('SELECT id::text,name FROM syncup.teams ORDER BY name,id').fetchall()
    return dict(user_id=user_id, name=user['name'], teams=teams)


def shared_cards(c, team_id, user_id, method, tail, data):
    """GET /items and /items/{id}, POST /items; any other method or deeper path is 405."""
    if method == 'GET' and len(tail) <= 2:
        items = shared_items(c, team_id) if len(tail) == 1 else shared_item(c, team_id, path_id(tail[1]))
        return dict(team_id=str(team_id), items=items)
    if method == 'POST' and len(tail) == 1:
        team_lock(c, team_id)
        return publish(c, team_id, user_id, data)
    raise AccessError(405)


def path_id(segment):
    """A card or conflict id from one path segment; malformed percent-encoding is a 400, never a lookup."""
    return urllib.parse.unquote(segment, errors='strict')


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
        target = target_from_env()  # its messages name the setting, never the token
    except ValueError as error:
        parser.error(str(error))
    try:
        verify_database(dsn)
    except DatabaseSetupError as error:
        parser.error(str(error))
    except (ValueError, psycopg.Error):
        # Driver messages can contain connection details; show only the kind of problem.
        parser.error('제한된 syncup_api 계정과 팀 DB 연결을 확인하세요.')
    with TeamServer(('127.0.0.1', args.port), TeamHandler) as srv:
        srv.dsn, srv.repo_target = dsn, target
        print(f'팀 API http://127.0.0.1:{srv.server_port}/ · 외부 연결은 HTTPS 프록시 필요', flush=True)
        srv.serve_forever()


if __name__ == '__main__':
    main()
