"""Local review service: private review page, loopback or team board, extension /rpc (--integrated), scan and delivery workers."""
import argparse
import datetime as dt
import hmac
import html
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse

from collector import LABELS, active, config, connect, initialize, process, scan
from delivery import PACKET_FIELDS, approve, deliver, validate_packet
from storage import runtime_lock
from runtime import child_environment, require_platform, storage_paths
from team_client import TeamClient, NETWORK_ERRORS, bind_sharing
from diagnostics import failure
import retention

def esc(s):
    return html.escape(str(s), quote=True)


STYLE = """
*{box-sizing:border-box}body{margin:0;background:#f3f3ed;color:#1d332d;font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:820px;margin:0 auto;padding:42px 24px 80px}header{border-bottom:2px solid #1e4439;padding-bottom:18px}
nav,header,footer,.actions{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
h1{font-size:clamp(30px,5vw,48px);letter-spacing:-.06em;margin:10px 0}h2{font-size:20px;margin:0}small,summary{color:#456357}
article{background:#fffefa;border:1px solid #c6d3c7;border-radius:12px;padding:22px;margin:16px 0}
blockquote{border-left:3px solid #8ea496;margin:10px 0;padding:4px 12px}a{color:#225941}
button{background:#215440;color:white;border:0;border-radius:7px;padding:9px 15px;font:inherit;cursor:pointer}
textarea,select,input{font:inherit;border:1px solid #8ea295;border-radius:6px;padding:8px;width:100%;color:inherit;background:white}
textarea{min-height:68px}label{display:block;font-size:14px;font-weight:600;margin:10px 0}
.state{font-size:14px;background:#e2ebdf;padding:6px 10px;border-radius:5px}.note{color:#4e5d52}
"""


def page(title, body, refresh=False):
    # Server-rendered lists arrive with the document. Poll only while the user is idle.
    script = """<script>let edited=false;document.addEventListener('input',()=>edited=true);
    setInterval(()=>{if(!edited && !document.hidden && document.activeElement===document.body && !document.querySelector('details[open]'))location.reload()},6000)</script>""" if refresh else ""
    return f'<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · 싱크업</title><style>{STYLE}</style><main>{body}</main>{script}</html>'


class LocalHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value, mime="text/html; charset=utf-8"):
        data=value.encode()
        self.send_response(status)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(data)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Frame-Options","DENY")
        self.send_header("Referrer-Policy","no-referrer")
        self.send_header("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        try:
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # A disconnected client cannot receive a second error response.
            self.close_connection = True

    def valid_host(self):
        return self.headers.get("Host")==f"127.0.0.1:{self.server.server_port}"

    def body(self, limit=65536):
        self.connection.settimeout(10)
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("지원하지 않는 요청 형식입니다.")
        n=int(self.headers.get("Content-Length","0"))
        if not 0<n<=limit:
            raise ValueError("요청 크기를 확인해 주세요.")
        data = self.rfile.read(n)
        if len(data) != n:
            raise ValueError("요청이 끝나지 않았습니다.")
        return data


class Board(LocalHandler):
    def do_GET(self):
        if not self.valid_host() or self.path!="/":
            return self.reply(404,"페이지를 찾을 수 없습니다.")
        with connect(self.server.db) as c:
            rows=c.execute("SELECT * FROM records ORDER BY rowid DESC").fetchall()
        body='<header><h1>팀 보드</h1><span class="state">로컬 시연 팀</span></header>'
        body+=f'<p>승인된 카드 {len(rows)}장</p>'
        for r in rows:
            body+=f'<article><small>{esc(r["label"])}</small><h2>{esc(r["text"])}</h2><blockquote>{esc(r["quote"])}</blockquote><small>근거 · {esc(r["speaker"])}</small></article>'
        self.reply(200,page("팀 보드",body,True))

    def do_POST(self):
        if not self.valid_host() or self.path!="/items/approve" or not hmac.compare_digest(self.headers.get("Authorization",""),"Bearer "+self.server.secret):
            return self.reply(403,"거절됨")
        try:
            d=json.loads(self.body())
            validate_packet(d)
            with connect(self.server.db) as c:
                c.execute("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",tuple(d[k] for k in PACKET_FIELDS))
                saved=dict(c.execute("SELECT * FROM records WHERE id=?",(d["id"],)).fetchone())
            if saved!=d: return self.reply(409,"이전 승인과 내용이 다릅니다.")
            self.reply(200,json.dumps({"id":d["id"]}),"application/json")
        except (ValueError,TypeError,KeyError):
            self.reply(400,"승인 형식 오류")
        except (sqlite3.Error, OSError):
            self.reply(503,"팀 보드 저장을 확인하지 못했습니다.")


class Review(LocalHandler):
    def do_GET(self):
        if self.valid_host() and self.path == '/team-board' and getattr(self.server, 'team_client', None):
            return self.team_board()
        if not self.valid_host() or self.path!="/": return self.reply(404,"페이지를 찾을 수 없습니다.")
        db=self.server.db
        cfg=config(db)
        token=f'<input type="hidden" name="csrf" value="{self.server.csrf}">'
        state="종료" if time.time()>=cfg["end"] else "일시중지" if cfg["paused"] else "수집 중"
        toggle="resume" if cfg["paused"] else "pause"
        body=f'<nav><b>싱크업</b><a href="{self.server.board_url}">팀 보드 열기 ↗</a></nav><header><h1>개인 검토함</h1><span class="state">{state}</span></header>'
        client = getattr(self.server, 'team_client', None)
        target_team, team_name, teams = None, None, {}
        if client:
            try:
                profile = client.me()
                teams = {t['id']: t['name'] for t in profile['teams']}
                with connect(db) as c:
                    binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
                target_team = binding['team_id']
                team_name = teams.get(target_team)
                options = '<option value="">공유할 팀 선택</option>' + ''.join(
                    f'<option value="{esc(t)}" {"selected" if t==target_team else ""}>{esc(name)}</option>' for t,name in teams.items())
                body += f'<p>연결 사용자 · {esc(profile["name"])}</p><form method="post" action="/switch-team">{token}<label>새로 승인할 카드의 대상 팀<select name="team_id" required>{options}</select></label><button>대상 팀 변경</button></form><p class="note">팀을 바꿔도 이미 승인한 카드의 대상 팀은 바뀌지 않습니다.</p>'
                if not team_name:
                    body += '<p role="alert">공유할 팀을 선택하세요. 권한이 없어진 팀에는 공유할 수 없습니다.</p>'
            except NETWORK_ERRORS:
                body += '<p role="alert">팀 연결을 확인할 수 없습니다. 팀 승인은 잠시 차단됩니다.</p>'
        end=dt.datetime.fromtimestamp(cfg["end"]).strftime("%m/%d %H:%M")
        body+=f'<p><strong>{esc(Path(cfg["project"]).name)}</strong> · {end}까지</p><p class="note">새 Codex·Claude Code 대화의 발췌를 OpenAI에서 분류하고 초안을 작성합니다. 아래에서 승인한 문구와 근거만 팀 보드에 올라갑니다.</p>'
        if state!="종료":
            label="재개" if cfg["paused"] else "일시중지"
            body+=f'<form method="post" action="/{toggle}">{token}<button>{label}</button></form>'
        with connect(db) as c:
            binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
            retry_team = binding['team_id'] if binding else ''
            retry_token = token + f'<input type="hidden" name="teamId" value="{esc(retry_team)}">'
            rows=c.execute("""SELECT cards.*,jobs.evidence,outbox.state AS delivery_state,outbox.detail AS delivery_detail,
                outbox.attempts,outbox_destinations.team_id AS approved_team
                FROM cards JOIN jobs ON jobs.id=cards.job LEFT JOIN outbox ON outbox.id=cards.id
                LEFT JOIN outbox_destinations ON outbox_destinations.id=cards.id
                ORDER BY cards.rowid DESC""").fetchall()
            if getattr(self.server, 'pipeline', None):
                errors = c.execute("""SELECT j.* FROM jobs j JOIN job_context x ON x.job=j.id
                    WHERE x.team_id=? AND j.state='failed_new'""", (retry_team,)).fetchall()
                issues = c.execute('''SELECT reason,message FROM intake_issues WHERE team_id=(SELECT team_id FROM sharing)
                    AND id NOT IN (SELECT issue_id FROM intake_resolutions) ORDER BY received''').fetchall()
                if issues:
                    body += f'<p role="alert">자동 처리에서 제외하여 보관한 입력 {len(issues)}개가 있습니다. 원래 입력은 덮어쓰지 않았습니다.</p>'
                    for issue in issues:
                        body += f'<details><summary>{esc(issue["reason"])}</summary><pre>{esc(json.loads(issue["message"]))}</pre></details>'
            else:
                errors=c.execute("SELECT * FROM jobs WHERE state LIKE 'failed_%'").fetchall()
        if cfg["status"]: body+=f'<p role="alert">{esc(cfg["status"])}</p>'
        for j in errors:
            body+=f'<form method="post" action="/retry">{retry_token}<input type="hidden" name="id" value="{esc(j["id"])}">처리 실패 · {esc(j["detail"])} <button>다시 시도</button></form>'
        if not rows: body+='<article>아직 후보가 없습니다. 선택한 프로젝트에서 새 Codex 또는 Claude Code 대화를 시작하면 완료된 발화를 확인합니다.</article>'
        for r in rows:
            label=LABELS[r["kind"]]
            if r["kind"]=="decision" and not r["adopted"]: label+=" · 채택 미확인"
            body+=f'<article><h2>{label}</h2>'
            if r['approved_team']:
                body += f'<p>승인 대상 · {esc(teams.get(r["approved_team"], "접근 불가 또는 이전 팀"))} <small>{esc(r["approved_team"])}</small></p>'
            elif client and r['status'] in ('queued', 'shared'):
                body += '<p class="note">이전 로컬 시연 승인 · 팀 서버로 자동 공유하지 않음</p>'
            evidence = json.loads(r["evidence"])
            source = "Claude Code" if evidence and evidence[0].get("source") == "claude-code" else "Codex"
            if evidence and evidence[0].get("continuation_of"): source += " · 추가 답변"
            body+=f'<small>출처 · {source}</small>'
            if r["status"]=="drafting":
                body+='<p role="status">Terra가 근거와 초안을 정리하고 있습니다.</p>'
            elif r["status"]=="shared":
                body+=f'<p>{esc(r["draft"])}</p><small>공유 완료</small>'
            elif r["status"]=="queued":
                body+=f'<p>{esc(r["draft"])}</p><blockquote>{esc(r["quote"])}</blockquote>'
                if r["delivery_state"]=="blocked":
                    body+=f'<p role="alert">전송 확인 필요 · {esc(r["delivery_detail"])}</p><form method="post" action="/retry-delivery">{retry_token}<input type="hidden" name="id" value="{esc(r["id"])}"><button>승인한 내용 그대로 재시도</button></form>'
                else:
                    body+=f'<p role="status">승인 저장됨 · 전송 대기 · 시도 {r["attempts"]}회</p>'
            else:
                body+=f'<form method="post" action="/approve">{token}<input type="hidden" name="id" value="{esc(r["id"])}"><label>팀에 공유할 문구<textarea name="text" maxlength="1200" required>{esc(r["draft"] or "")}</textarea></label>'
                if r["status"]=="manual":
                    opts="".join(f'<option value="{x["n"]}">{esc(x["role"])} · {esc(x["text"])}</option>' for x in json.loads(r["evidence"]))
                    body+=f'<label>수동 작성 · 공유할 근거 선택<select name="source" required><option value="">근거 선택</option>{opts}</select></label>'
                else:
                    speaker="사용자" if r["role"]=="user" else "AI"
                    body+=f'<label>{speaker} 근거 · 공유할 범위<textarea name="quote" maxlength="1200" required>{esc(r["quote"])}</textarea></label>'
                if client:
                    body += f'<input type="hidden" name="target_team" value="{esc(target_team or "")}"><button {"disabled" if not team_name else ""}>{esc(team_name or "팀 선택 필요")} · 이 카드 한 장 승인</button></form>'
                else:
                    body+='<button>이 카드 한 장 승인</button></form>'
            if r["status"]=="drafting":
                body+="<details><summary>분류에 사용한 발췌</summary>"+"".join(f'<blockquote>{esc(x["role"])} · {esc(x["text"])}</blockquote>' for x in json.loads(r["evidence"]))+"</details>"
            body+="</article>"
        self.reply(200,page("개인 검토함",body,True))

    def team_board(self):
        client = self.server.team_client
        try:
            profile = client.me()
            with connect(self.server.db) as c:
                binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
            team_id = binding['team_id']
            name = next((t['name'] for t in profile['teams'] if t['id'] == team_id), None)
            if name is None:
                return self.reply(403, page('팀 선택 필요', '<a href="/">개인 검토함에서 접근 가능한 팀을 선택하세요.</a>'))
            rows = client.items(team_id)
            body = f'<nav><b>싱크업</b><a href="/">개인 검토함</a></nav><header><h1>{esc(name)} · 팀 보드</h1></header><p>최근 승인 카드 {len(rows)}장 (최대 200장)</p>'
            for row in rows:
                r = row['packet']
                body += f'<article><small>{esc(r["label"])}</small><h2>{esc(r["text"])}</h2><blockquote>{esc(r["quote"])}</blockquote><small>근거 · {esc(r["speaker"])}</small></article>'
            self.reply(200, page('팀 보드', body, True))
        except (*NETWORK_ERRORS, KeyError, TypeError):
            self.reply(503, page('팀 연결 확인', '<p role="alert">팀 권한이나 연결을 확인할 수 없습니다.</p><a href="/">개인 검토함</a>'))

    def do_POST(self):
        if self.path == '/rpc' and getattr(self.server, 'pipeline', None):
            if (not self.valid_host() or self.headers.get('Origin') is not None or
                    not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+self.server.rpc_secret)):
                return self.reply(403, '{"error":"로컬 연결 인증 실패"}', 'application/json')
            try:
                request = json.loads(self.body(4*1024*1024))
                if not isinstance(request,dict) or set(request) != {'version','method','params'} or type(request['version']) is not int or request['version'] != 1 or not isinstance(request['method'],str):
                    raise ValueError('요청 버전 오류')
                result = self.server.pipeline.rpc(request['method'], request['params'])
                return self.reply(200,json.dumps(dict(ok=True,result=result),ensure_ascii=False),'application/json')
            except (ValueError,TypeError,KeyError) as error:
                return self.reply(400,json.dumps(dict(ok=False,error=str(error)),ensure_ascii=False),'application/json')
            except Exception as error:
                failure('local_rpc', error)
                return self.reply(503,'{"ok":false,"error":"로컬 저장소 또는 팀 연결을 확인하세요."}','application/json')
        try:
            # Privacy-preserving browsers can send an opaque Origin on a form POST.
            if not self.valid_host() or self.headers.get("Origin") not in (None,"null",f"http://127.0.0.1:{self.server.server_port}"):
                return self.reply(403,"거절됨")
            fields=urllib.parse.parse_qs(self.body().decode(),strict_parsing=True)
            get=lambda k:fields[k][0]
            if not hmac.compare_digest(get("csrf"),self.server.csrf): return self.reply(403,"거절됨")
            client = getattr(self.server, 'team_client', None)
            pipeline = getattr(self.server, 'pipeline', None)
            retry = self.path in ('/retry', '/retry-delivery')
            if retry:
                if len(fields.get('id', [])) != 1 or not get('id').strip():
                    raise ValueError('재시도할 항목을 확인하세요.')
                if (pipeline or client) and (len(fields.get('teamId', [])) != 1 or not get('teamId').strip()):
                    raise ValueError('대상 팀을 확인하세요.')
                if pipeline:
                    # Reuse the RPC transaction; never acquire the SQLite lock before it.
                    pipeline.rpc('jobs.retry' if self.path == '/retry' else 'delivery.retry',
                                 dict(id=get('id'), teamId=get('teamId')))
                    self.send_response(303)
                    self.send_header('Location', '/')
                    self.end_headers()
                    return
            profile = client.me() if client and self.path in ('/switch-team','/approve') else None
            with connect(self.server.db) as c:
                c.execute("BEGIN IMMEDIATE")
                if retry and client:
                    binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
                    if not binding or get('teamId') != binding['team_id']:
                        raise ValueError('대상 팀이 변경되었습니다.')
                if self.path in ("/pause","/resume"):
                    if self.path=="/pause":
                        c.execute("INSERT INTO pauses(start) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM pauses WHERE end IS NULL)",(time.time(),))
                    else:
                        c.execute("UPDATE pauses SET end=? WHERE end IS NULL",(time.time(),))
                    c.execute("UPDATE settings SET paused=?",(int(self.path=="/pause"),))
                elif self.path=="/retry":
                    if not active(c.execute('SELECT * FROM settings').fetchone()):
                        raise ValueError('수집 시간이 종료되었거나 일시중지되었습니다.')
                    updated = c.execute("UPDATE jobs SET state=substr(state,8),detail='' WHERE id=? AND state IN ('failed_new','failed_draft')",(get("id"),))
                    if updated.rowcount != 1: raise ValueError('재시도할 작업이 없습니다.')
                    c.execute("UPDATE cards SET status='drafting' WHERE job=? AND status='manual'",(get("id"),))
                elif self.path=="/retry-delivery":
                    scope = """id IN (SELECT d.id FROM outbox_destinations d JOIN sharing s
                        ON s.team_id=d.team_id AND s.user_id=d.user_id AND s.api_url=d.api_url)""" if client else \
                        'id NOT IN (SELECT id FROM outbox_destinations)'
                    updated = c.execute("UPDATE outbox SET state='pending',attempts=0,next_attempt=0,detail='' WHERE id=? AND state='blocked' AND " + scope,(get("id"),))
                    if updated.rowcount != 1: raise ValueError('재시도할 전송이 없습니다.')
                elif self.path == '/switch-team':
                    if not client:
                        return self.reply(400, '팀 서버 연결이 필요합니다.')
                    bind_sharing(c, client, get('team_id'), profile)
                    if pipeline:
                        options = json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])
                        options['profile'] = profile
                        c.execute('UPDATE integration_settings SET config=?', (json.dumps(options),))
                elif self.path=="/approve":
                    destination = None
                    if client:
                        binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
                        if (get('target_team') != binding['team_id'] or
                                binding['team_id'] not in {t['id'] for t in profile['teams']}):
                            raise ValueError('팀 선택이나 권한이 변경되었습니다.')
                        destination = dict(binding)
                    approve(c,get,destination)
                else: return self.reply(404,"찾을 수 없습니다.")
            self.send_response(303)
            self.send_header("Location","/")
            self.end_headers()
        except (KeyError,ValueError,IndexError):
            self.reply(400,"입력값·인용 근거·대상 팀을 확인해 주세요. 팀을 바꿨다면 검토함을 새로고침한 뒤 승인하세요.")
        except (sqlite3.Error,OSError,http.client.HTTPException):
            self.reply(503,"로컬 저장을 확인하지 못했습니다. 같은 카드로 다시 시도해 주세요.")


def send_approved(srv):
    while True:
        try:
            deliver(srv.db, srv.board_url, srv.secret, getattr(srv, 'team_client', None))
        except Exception as error:
            failure('delivery', error)
        time.sleep(1)


def run_integrated(db, pipeline):
    """Integrated collection after a scan; returns the status to show instead of the scan's, or None.

    Standard path: capture_local_jobs moves new scanned jobs into the pipeline's intake, then
    pipeline.process classifies its batches. Legacy drain: process(drafts_only=True) only finishes
    'draft' jobs left by the pre-integration collector. Integrated mode never classifies new jobs into 'draft', and
    its review page retries only integrated jobs, so 'failed_draft' jobs (from before integration or from this drain)
    are never retried (existing behavior).
    """
    status = None
    try:
        pipeline.capture_local_jobs()
    except Exception as error:
        failure('local_intake', error)
        status = '로컬 발췌 변환 실패 · 원본 작업 보존'
    pipeline.process()
    process(db, drafts_only=True, gate=pipeline.privacy)
    return status


def watch(db,codex,claude=None,codex_sqlite=None,claude_project=None,pipeline=None):
    """Collection loop. With a pipeline (--integrated) it runs run_integrated: the standard path, then
    the legacy-compat drain. Without one, process(db) classifies and drafts every job itself."""
    last_retention = 0
    while True:
        # Retention runs even while collection is paused or ended: settled raw text still expires.
        if time.time() - last_retention >= 3600:
            last_retention = time.time()
            try:
                retention.sweep(db)
            except Exception as error:
                failure('retention', error)
        try:
            if active(config(db)):
                scan_status = ""
                try:
                    scan(db,codex,claude,codex_sqlite,claude_project)
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    failure('collection_scan', error)
                    scan_status = "대화 기록 확인 실패 · " + type(error).__name__
                if pipeline:
                    scan_status = run_integrated(db, pipeline) or scan_status
                else:
                    process(db)
                with connect(db) as c: c.execute("UPDATE settings SET status=?", (scan_status,))
        except Exception as e:
            failure('collection_worker', e)
            with connect(db) as c: c.execute("UPDATE settings SET status=?",("대화 처리 실패 · "+type(e).__name__,))
        time.sleep(2)


def main():
    require_platform()
    parser=argparse.ArgumentParser()
    parser.add_argument("mode",choices=["run","board"])
    parser.add_argument("--project",type=Path)
    parser.add_argument("--state",type=Path,required=True)
    parser.add_argument("--minutes",type=int,default=120)
    parser.add_argument("--port",type=int,default=8876)
    parser.add_argument("--board-port",type=int,default=8877)
    parser.add_argument("--codex-dir",type=Path)
    parser.add_argument("--codex-sqlite-dir",type=Path)
    parser.add_argument("--claude-dir",type=Path)
    parser.add_argument("--claude-project-name")
    parser.add_argument('--team-api', help='HTTPS 팀 API 주소 (로컬 검사는 http://127.0.0.1 허용)')
    parser.add_argument('--team-token-file', type=Path, help='현재 사용자만 읽을 수 있는 연결 키 파일')
    parser.add_argument('--team-id', help='최초 또는 시작 시 선택할 팀 ID')
    parser.add_argument('--integrated', action='store_true', help='통합 분류와 확장 프로그램 연결 활성화')
    args=parser.parse_args()
    if args.integrated and not args.team_api:
        parser.error('--integrated는 인증된 팀 서버 연결이 필요합니다.')
    if bool(args.team_api) != bool(args.team_token_file) or (args.team_id and not args.team_api):
        parser.error('--team-api와 --team-token-file을 함께 지정하세요.')
    if args.mode == "run":
        try:
            args.codex_dir,args.codex_sqlite_dir,args.claude_dir,args.claude_project_name=storage_paths(args)
        except (ValueError, OSError):
            parser.error("대화 저장 위치 설정을 확인하세요. 필요하면 --codex-sqlite-dir로 DB 폴더를 직접 지정하세요.")
    def terminate(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    os.umask(0o077)
    args.state.mkdir(parents=True,exist_ok=True)
    with runtime_lock(args.state / (args.mode + ".lock")):
        serve(args, parser)


def serve(args, parser):
    if args.mode=="board":
        srv=http.server.ThreadingHTTPServer(("127.0.0.1",args.board_port),Board)
        srv.db=args.state/"board.sqlite"
        srv.secret=sys.stdin.readline().strip()
        if not srv.secret: raise SystemExit("검토함에서 시작해 주세요.")
        initialize(srv.db, board=True)
        # The parent keeps this pipe open; its death must not leave a locked orphan board.
        def parent_exit():
            sys.stdin.read()
            os._exit(0)
        threading.Thread(target=parent_exit, daemon=True).start()
        print("ready",flush=True)
        srv.serve_forever()
        return
    if not args.project or not args.project.is_dir() or not 1<=args.minutes<=1440: parser.error("프로젝트 폴더와 1~1440분의 기간을 확인해 주세요.")
    srv=http.server.ThreadingHTTPServer(("127.0.0.1",args.port),Review)
    srv.db=args.state/"private.sqlite"
    initialize(srv.db)
    with connect(srv.db) as c:
        s=c.execute("SELECT * FROM settings").fetchone()
        if s and s["project"]!=str(args.project.resolve()): parser.error("프로젝트마다 별도의 --state 폴더를 사용해 주세요.")
        if not s: c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')",(str(args.project.resolve()),time.time(),time.time()+args.minutes*60))
    srv.csrf=secrets.token_urlsafe(32)
    srv.secret=secrets.token_urlsafe(32)
    srv.team_client = None
    if args.team_api:
        try:
            with connect(srv.db) as c:
                binding = c.execute('SELECT * FROM sharing').fetchone()
            recover = bool(args.integrated and binding)
            srv.team_client = TeamClient(args.team_api, args.team_token_file, binding['user_id'] if recover else None)
            if recover and binding['api_url'] != srv.team_client.api_url:
                raise ValueError('오프라인 복구는 기존 연결에서만 가능합니다.')
            try:
                profile = srv.team_client.me()
            except NETWORK_ERRORS as error:
                if not recover or (args.team_id is not None and args.team_id != binding['team_id']):
                    raise
                failure('profile_recovery', error)
                profile = None
            if profile is not None:
                with connect(srv.db) as c:
                    bind_sharing(c, srv.team_client, args.team_id, profile)
        except (*NETWORK_ERRORS, KeyError, TypeError):
            parser.error('팀 연결 키, 소속 팀과 기존 상태 폴더의 연결 사용자를 확인하세요.')
        srv.board_url = '/team-board'
        srv.pipeline = None
        if args.integrated:
            from integration import Pipeline
            srv.pipeline = Pipeline(srv.db,srv.team_client,profile)
            srv.rpc_secret = secrets.token_urlsafe(32)
            connection = args.state/'connection.json'
            connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc',token=srv.rpc_secret)))
            connection.chmod(0o600)
        threading.Thread(target=watch,args=(srv.db,args.codex_dir,args.claude_dir,args.codex_sqlite_dir,args.claude_project_name,srv.pipeline),daemon=True).start()
        threading.Thread(target=send_approved,args=(srv,),daemon=True).start()
        print(f'개인 검토함 http://127.0.0.1:{srv.server_port}/ · ' + ('팀 연결 확인됨' if profile else '로컬 복구 모드 · 공유 시 권한 재확인'), flush=True)
        try:
            srv.serve_forever()
        finally:
            srv.server_close()
        return
    with connect(srv.db) as c:
        if c.execute('SELECT 1 FROM sharing').fetchone():
            parser.error('이 상태 폴더는 팀 서버에 연결되어 있습니다. 기존 팀 연결 설정을 지정하세요.')
    srv.board_url=f"http://127.0.0.1:{args.board_port}/"
    child=subprocess.Popen([sys.executable,__file__,"board","--state",str(args.state),"--board-port",str(args.board_port)],
            env=child_environment(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,encoding="utf-8")
    try:
        child.stdin.write(srv.secret+"\n"); child.stdin.flush()
        if child.stdout.readline().strip()!="ready": raise SystemExit("팀 보드를 시작할 수 없습니다.")
        threading.Thread(target=watch,args=(srv.db,args.codex_dir,args.claude_dir,args.codex_sqlite_dir,args.claude_project_name),daemon=True).start()
        threading.Thread(target=send_approved,args=(srv,),daemon=True).start()
        print(f"검토함 http://127.0.0.1:{args.port}/ · 보드 {srv.board_url}",flush=True)
        srv.serve_forever()
    finally:
        child.terminate()
        child.wait()
        child.stdin.close()
        child.stdout.close()

if __name__=="__main__":
    main()
