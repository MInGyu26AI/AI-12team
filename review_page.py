"""Private review page handler (`app.py run`): page and form actions, plus /rpc for the extension (--integrated)."""
import hmac
import http.client
import json
import sqlite3
import urllib.parse

from collection_settings import cache_profile
from collection_session import active, bind_sharing, set_paused
from collector import FAILED_PREFIX
from delivery import approve, reset_blocked
from diagnostics import failure
import local_rpc
from review_render import render_review_page, render_team_board
from secure_http import RPC_LIMIT, SecureHandler
from storage import connect
from team_client import TEAM_UNREACHABLE_ERRORS

BAD_INPUT = "입력값·인용 근거·대상 팀을 확인해 주세요. 팀을 바꿨다면 검토함을 새로고침한 뒤 승인하세요."
STORAGE_FAILED = "로컬 저장을 확인하지 못했습니다. 같은 카드로 다시 시도해 주세요."
TEAM_UNREACHABLE = "팀 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."
# Approving, retrying a delivery and switching teams all need the team server (app.py always connects one).
NEEDS_TEAM = '팀 서버 연결이 필요합니다.'
JSON = "application/json"


def _check_retry_fields(fields, needs_team):
    if len(fields.get('id', [])) != 1 or not fields['id'][0].strip():
        raise ValueError('재시도할 항목을 확인하세요.')
    if needs_team and (len(fields.get('teamId', [])) != 1 or not fields['teamId'][0].strip()):
        raise ValueError('대상 팀을 확인하세요.')


def _pause(review, c, get, profile):
    set_paused(c, True)


def _resume(review, c, get, profile):
    set_paused(c, False)


def _retry_job(review, c, get, profile):
    """Legacy collector retry: back to the state before 'failed_' and redraft manual cards."""
    if not active(c.execute('SELECT * FROM settings').fetchone()):
        raise ValueError('수집 시간이 종료되었거나 일시중지되었습니다.')
    updated = c.execute("UPDATE jobs SET state=replace(state,?,''),detail='' WHERE id=? AND state IN (?,?)",
                        (FAILED_PREFIX, get("id"), FAILED_PREFIX + "new", FAILED_PREFIX + "draft"))
    if updated.rowcount != 1:
        raise ValueError('재시도할 작업이 없습니다.')
    c.execute("UPDATE cards SET status='drafting' WHERE job=? AND status='manual'", (get("id"),))


def _retry_delivery(review, c, get, profile):
    if not review.team_client:
        return 400, NEEDS_TEAM
    if not reset_blocked(c, get("id")):
        raise ValueError('재시도할 전송이 없습니다.')


def _switch_team(review, c, get, profile):
    if not review.team_client:
        return 400, NEEDS_TEAM
    bind_sharing(c, review.team_client, get('team_id'), profile)
    if review.pipeline:
        cache_profile(c, profile)


def _approve(review, c, get, profile):
    if not review.team_client:
        return 400, NEEDS_TEAM
    binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
    if get('target_team') != binding['team_id'] or binding['team_id'] not in {t['id'] for t in profile['teams']}:
        raise ValueError('팀 선택이나 권한이 변경되었습니다.')
    approve(c, get, dict(binding))


# Each runs in one BEGIN IMMEDIATE transaction; it returns None (303 back to the page) or (status, text).
FORM_ACTIONS = {'/pause': _pause, '/resume': _resume, '/retry': _retry_job, '/retry-delivery': _retry_delivery,
                '/switch-team': _switch_team, '/approve': _approve}


class Review(SecureHandler):
    # app._open_review_server sets both; the team checks' servers set only team_client.
    @property
    def team_client(self):
        return getattr(self.server, 'team_client', None)

    @property
    def pipeline(self):
        return getattr(self.server, 'pipeline', None)

    def do_GET(self):
        if self.valid_host() and self.path == '/team-board' and self.team_client:
            return self.reply(*render_team_board(self.server.db, self.team_client))
        if not self.valid_host() or self.path != "/":
            return self.reply(404, "페이지를 찾을 수 없습니다.")
        self.reply(200, render_review_page(self.server, self.team_client, self.pipeline))

    def do_POST(self):
        if self.path == '/rpc' and self.pipeline:
            return self.answer_rpc()
        try:
            refused = self.submit_form()
        except (KeyError, ValueError, IndexError):
            return self.reply(400, BAD_INPUT)
        except (sqlite3.Error, OSError, http.client.HTTPException):
            return self.reply(503, STORAGE_FAILED)
        if refused:
            return self.reply(*refused)
        self.redirect_home()

    def answer_rpc(self):
        if (not self.valid_host() or self.headers.get('Origin') is not None or
                not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.rpc_secret)):
            return self.reply(403, '{"error":"로컬 연결 인증 실패"}', JSON)
        try:
            method, params = local_rpc.read_envelope(json.loads(self.body(RPC_LIMIT)))
            result = local_rpc.dispatch(self.pipeline, method, params)
            return self.reply(200, json.dumps(dict(ok=True, result=result), ensure_ascii=False), JSON)
        except (ValueError, TypeError, KeyError) as error:
            return self.reply(400, json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False), JSON)
        except Exception as error:
            failure('local_rpc', error)
            return self.reply(503, '{"ok":false,"error":"로컬 저장소 또는 팀 연결을 확인하세요."}', JSON)

    def submit_form(self):
        """Run one form action; None means done (303), otherwise (status, text) to answer instead."""
        # Privacy-preserving browsers can send an opaque Origin on a form POST.
        allowed_origins = (None, "null", f"http://127.0.0.1:{self.server.server_port}")
        if not self.valid_host() or self.headers.get("Origin") not in allowed_origins:
            return 403, "거절됨"
        fields = urllib.parse.parse_qs(self.body().decode(), strict_parsing=True)
        get = lambda k: fields[k][0]
        if not hmac.compare_digest(get("csrf"), self.server.csrf):
            return 403, "거절됨"
        retry = self.path in ('/retry', '/retry-delivery')
        if retry:
            _check_retry_fields(fields, needs_team=bool(self.pipeline or self.team_client))
            if self.pipeline:
                # Reuse the RPC transaction; never acquire the SQLite lock before it.
                method = 'jobs.retry' if self.path == '/retry' else 'delivery.retry'
                local_rpc.dispatch(self.pipeline, method, dict(id=get('id'), teamId=get('teamId')))
                return None
        action = FORM_ACTIONS.get(self.path)
        if action is None:
            return 404, "찾을 수 없습니다."
        profile = None
        if self.team_client and self.path in ('/switch-team', '/approve'):
            try:
                profile = self.team_client.me()
            except TEAM_UNREACHABLE_ERRORS:
                return 503, TEAM_UNREACHABLE
        with connect(self.server.db) as c:
            c.execute("BEGIN IMMEDIATE")
            if retry and self.team_client:
                binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
                if not binding or get('teamId') != binding['team_id']:
                    raise ValueError('대상 팀이 변경되었습니다.')
            return action(self, c, get, profile)
