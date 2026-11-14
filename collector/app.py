"""Local review service entry point.

`app.py run --team-api … --team-token-file …`: the private review page (review_page) and the collection and delivery
workers (collection_loop) of one state folder connected to a team server, and with --integrated the extension's /rpc
over the turn pipeline. It does not start without a team server connection.
"""
import sys
from pathlib import Path

# 폴더별로 실행해도 contract/ 의 공용 모듈과 저장소 루트의 ai/ 를 찾는다
_REPO = Path(__file__).resolve().parents[1]
sys.path[1:1] = [str(_REPO / 'contract'), str(_REPO)]

import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import threading
import time

from collection_loop import send_approved, watch
from collection_session import bind_sharing
from diagnostics import failure
from private_files import make_private_directory
from review_page import Review
from runtime import require_platform, storage_paths
from secure_http import LoopbackServer
from storage import connect, initialize, runtime_lock
from team_client import TEAM_ERRORS, TEAM_UNREACHABLE_ERRORS, KeyFileError, TeamClient
from turn_pipeline import TurnPipeline

MAX_MINUTES = 1440
NEEDS_TEAM = '팀 서버 연결이 필요합니다. --team-api와 --team-token-file을 지정하세요 (docs/team-server.md 참고).'


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["run"])
    parser.add_argument("--project", type=Path)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--minutes", type=int, default=120)
    parser.add_argument("--port", type=int, default=8876)
    parser.add_argument("--codex-dir", type=Path)
    parser.add_argument("--codex-sqlite-dir", type=Path)
    parser.add_argument("--claude-dir", type=Path)
    parser.add_argument("--claude-project-name")
    parser.add_argument('--team-api', help='HTTPS 팀 API 주소 (로컬 검사는 http://127.0.0.1 허용)')
    parser.add_argument('--team-token-file', type=Path, help='현재 사용자만 읽을 수 있는 연결 키 파일')
    parser.add_argument('--team-id', help='최초 또는 시작 시 선택할 팀 ID')
    parser.add_argument('--integrated', action='store_true', help='통합 분류와 확장 프로그램 연결 활성화')
    args = parser.parse_args()
    if not args.team_api:
        raise SystemExit(NEEDS_TEAM)
    if not args.team_token_file:
        parser.error('--team-api와 --team-token-file을 함께 지정하세요.')
    try:
        args.codex_dir, args.codex_sqlite_dir, args.claude_dir, args.claude_project_name = storage_paths(args)
    except (ValueError, OSError):
        parser.error("대화 저장 위치 설정을 확인하세요. 필요하면 --codex-sqlite-dir로 DB 폴더를 직접 지정하세요.")
    return parser, args


def main():
    require_platform()
    parser, args = parse_args()

    def terminate(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    os.umask(0o077)
    try:
        make_private_directory(args.state)
    except OSError:
        raise SystemExit("상태 폴더를 현재 사용자 전용으로 만들 수 없습니다. 사용자 폴더 안의 새 폴더를 지정하세요.") from None
    with runtime_lock(args.state / "run.lock"):
        serve_review(args, parser)


def _open_review_server(args, parser):
    if not args.project or not args.project.is_dir() or not 1 <= args.minutes <= MAX_MINUTES:
        parser.error("프로젝트 폴더와 1~1440분의 기간을 확인해 주세요.")
    srv = LoopbackServer(("127.0.0.1", args.port), Review)
    srv.db = args.state / "private.sqlite"
    initialize(srv.db)
    project = str(args.project.resolve())
    with connect(srv.db) as c:
        s = c.execute("SELECT * FROM settings").fetchone()
        if s and s["project"] != project:
            parser.error("프로젝트마다 별도의 --state 폴더를 사용해 주세요.")
        if not s:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (project, time.time(), time.time() + args.minutes * 60))
    srv.csrf = secrets.token_urlsafe(32)
    srv.team_client = None
    srv.pipeline = None
    return srv


def _connect_team(srv, args, parser):
    """Bind the state folder to the team server; returns the profile, or None in offline recovery (--integrated only)."""
    try:
        with connect(srv.db) as c:
            binding = c.execute('SELECT * FROM sharing').fetchone()
        recover = bool(args.integrated and binding)
        srv.team_client = TeamClient(args.team_api, args.team_token_file, binding['user_id'] if recover else None)
        if recover and binding['api_url'] != srv.team_client.api_url:
            raise ValueError('오프라인 복구는 기존 연결에서만 가능합니다.')
        try:
            profile = srv.team_client.me()
        except TEAM_UNREACHABLE_ERRORS as error:  # a changed user or a malformed answer is not offline: it stops the start
            if not recover or (args.team_id is not None and args.team_id != binding['team_id']):
                raise
            failure('profile_recovery', error)
            return None
        with connect(srv.db) as c:
            bind_sharing(c, srv.team_client, args.team_id, profile)
        return profile
    except KeyFileError as error:  # the key file itself, not the server or the team: say what to fix
        parser.error(str(error))
    except (*TEAM_ERRORS, KeyError, TypeError):
        parser.error('팀 연결 키, 소속 팀과 기존 상태 폴더의 연결 사용자를 확인하세요.')


def _start_pipeline(srv, args, profile):
    """--integrated: the turn pipeline and the connection file the native host and local web read."""
    srv.pipeline = TurnPipeline(srv.db, srv.team_client, profile)
    srv.rpc_secret = secrets.token_urlsafe(32)
    connection = args.state / 'connection.json'
    connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc', token=srv.rpc_secret)))
    connection.chmod(0o600)


def start_workers(srv, args):
    sources = (args.codex_dir, args.claude_dir, args.codex_sqlite_dir, args.claude_project_name)
    threading.Thread(target=watch, args=(srv.db, *sources, srv.pipeline), daemon=True).start()
    threading.Thread(target=send_approved, args=(srv,), daemon=True).start()


def serve_review(args, parser):
    srv = _open_review_server(args, parser)
    profile = _connect_team(srv, args, parser)
    if args.integrated:
        _start_pipeline(srv, args, profile)
    start_workers(srv, args)
    print(f'개인 검토함 http://127.0.0.1:{srv.server_port}/ · ' + ('팀 연결 확인됨' if profile else '로컬 복구 모드 · 공유 시 권한 재확인'), flush=True)
    print('브라우저는 저절로 열리지 않습니다. 위 주소를 직접 여세요.', flush=True)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
