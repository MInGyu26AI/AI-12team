"""Persistent local demonstration. Real OAuth only; never connects to a production database.

Optional build/demo-state/auth.json contains supabase_url and publishable_key (public project settings).
No test identity is substituted when authentication is missing. Stop with Ctrl-C; demo DB is retained.
"""
import repo_paths  # noqa: F401
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import threading
import time
import urllib.request

import psycopg
from psycopg.conninfo import make_conninfo
from key_issue import KeyIssuer
from team_access import verify_database
from team_admin import init
from team_server import TeamHandler, TeamServer

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT/'build/demo-state'
CONTAINER = 'syncup-onboarding-demo-20261115'


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(value, f)


def main():
    os.umask(0o077)
    for port in (3000, 18878):
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise SystemExit(f'{port} 포트가 사용 중입니다. 기존 시연을 먼저 종료해 주세요.')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    auth_file = STATE/'auth.json'
    auth = json.loads(auth_file.read_text()) if auth_file.exists() else {}
    url, public_key = auth.get('supabase_url', ''), auth.get('publishable_key', '')
    issuer = None
    if url or public_key:
        # Validate using the production factory; only the URL and public publishable key are accepted.
        import key_issue
        from unittest.mock import patch
        with patch.dict(os.environ, {'SYNCUP_SUPABASE_URL': url, 'SYNCUP_SUPABASE_PUBLISHABLE_KEY': public_key}):
            issuer = key_issue.issuer_from_env()
    saved_file = STATE/'database.json'
    existing = subprocess.run(['docker', 'inspect', '--format', '{{index .Config.Labels "syncup.demo"}}', CONTAINER], capture_output=True, text=True)
    if existing.returncode == 0:
        if existing.stdout.strip() != 'onboarding-20261115' or not saved_file.exists():
            raise SystemExit('시연 DB 소유 정보를 확인할 수 없어 중단했습니다. 기존 DB는 변경하지 않았습니다.')
        saved = json.loads(saved_file.read_text())
        subprocess.run(['docker', 'start', CONTAINER], check=True, stdout=subprocess.DEVNULL)
    else:
        if saved_file.exists(): raise SystemExit('저장된 시연 DB가 없습니다. 기존 설정을 보존하고 확인해 주세요.')
        saved = dict(admin=secrets.token_urlsafe(32), api=secrets.token_urlsafe(32))
        private_json(saved_file, saved)
        subprocess.run(['docker', 'run', '-d', '--name', CONTAINER, '--label', 'syncup.demo=onboarding-20261115',
            '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=syncup_demo', 'postgres:17-alpine'],
            env=dict(os.environ, POSTGRES_PASSWORD=saved['admin']), check=True, stdout=subprocess.DEVNULL)
    port = subprocess.check_output(['docker', 'port', CONTAINER, '5432/tcp'], text=True).strip().split(':')[-1]
    dsn = make_conninfo(host='127.0.0.1', port=port, dbname='syncup_demo', user='postgres', password=saved['admin'])
    for attempt in range(100):
        try:
            with psycopg.connect(dsn, connect_timeout=1) as c:
                if not c.execute("SELECT to_regnamespace('syncup')").fetchone()[0]:
                    keyfile = STATE/'api-password.key'
                    if not keyfile.exists():
                        fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, 'w') as f: f.write(saved['api'])
                    init(c, keyfile)
            break
        except psycopg.OperationalError:
            if attempt == 99: raise SystemExit('로컬 시연 DB를 시작하지 못했습니다.') from None
            time.sleep(.2)
    api_dsn = make_conninfo(host='127.0.0.1', port=port, dbname='syncup_demo', user='syncup_api', password=saved['api'])
    verify_database(api_dsn, web_keys=issuer is not None)
    server = TeamServer(('127.0.0.1', 18878), TeamHandler)
    server.dsn, server.key_issuer = api_dsn, issuer
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    allowed = ('PATH', 'HOME', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR')
    env = {k: v for k, v in os.environ.items() if k in allowed}
    env.update(SYNCUP_WEB_ORIGIN='http://localhost:3000', SYNCUP_TEAM_API_URL='http://127.0.0.1:18878',
        NEXT_PUBLIC_SUPABASE_URL=url, NEXT_PUBLIC_USE_MOCK='false', NEXT_PUBLIC_LOCAL_BRIDGE='false',
        NEXT_PUBLIC_DEMO_MODE='true', NEXT_PUBLIC_DESKTOP_MAC_ARM64_URL='/downloads/SyncUp-mac-arm64-demo.zip',
        SYNCUP_NEXT_DIST='.next-demo', NEXT_TELEMETRY_DISABLED='1')
    web = subprocess.Popen(['node', 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'],
        cwd=ROOT/'web', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def stop(*_): raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        for _ in range(120):
            if web.poll() is not None: raise SystemExit('시연 웹을 시작하지 못했습니다.')
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/start', timeout=2) as r:
                    if r.status == 200: break
            except (OSError, TimeoutError): time.sleep(.5)
        else: raise SystemExit('시연 웹 응답을 기다리다 시간이 지났습니다.')
        print('시연 웹: http://localhost:3000/start', flush=True)
        print('실제 GitHub 로그인: ' + ('설정됨 — 브라우저에서 성공 여부 확인 필요' if issuer else '아직 미설정 — auth.json 필요'), flush=True)
        print('운영 DB와 분리된 시연입니다. 종료는 Ctrl-C. 시연 팀과 데이터는 보존합니다.', flush=True)
        while web.poll() is None: time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        web.terminate()
        try: web.wait(timeout=10)
        except subprocess.TimeoutExpired: web.kill(); web.wait()
        server.shutdown(); server.server_close()


if __name__ == '__main__': main()
