"""Bundled Mac/Windows setup UI in the user's browser. Only loopback, exact Host/Origin and an HttpOnly cookie.

No collection starts until the user presses Start. Browser signup and PC key issuance remain separate.
The optional personal AI key is held only in the child process environment, never saved or returned.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import webbrowser

import desktop_setup
import key_setup
from team_client import TeamClient
from runtime import child_environment


def open_connection_in_chrome(url):
    """The extension can complete the connection only in Chrome."""
    if sys.platform == 'darwin':
        result = subprocess.run(['open', '-a', 'Google Chrome', url], capture_output=True, timeout=10)
        if result.returncode == 0:
            return
    elif sys.platform == 'win32':
        import winreg
        key = r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, key) as registration:
                    executable = winreg.QueryValueEx(registration, '')[0]
                subprocess.Popen([executable, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                continue
    raise ValueError('Chrome을 열 수 없어요. 설치된 Chrome에서 위 SyncUp 웹 주소의 /connect를 열어 주세요.')


class DesktopState:
    def __init__(self, resources, source, executable_relative, home=None):
        self.resources, self.source = Path(resources), Path(source)
        self.relative = Path(executable_relative)
        self.config = desktop_setup.read_config(resources)
        self.root = desktop_setup.install_root(home)
        if self.config.get('local_demo') is True:
            self.root = self.root.with_name('SyncUp Demo')
        self.home = home
        self.executable = None
        pointer = self.root / 'installation.json'
        if pointer.exists():
            from private_files import read_private_file
            saved = json.loads(read_private_file(pointer, 4096, '설치 파일 권한을 확인해 주세요.'))
            installed = Path(saved['executable']).resolve()
            if installed.is_relative_to((self.root / 'versions').resolve()) and installed.is_file():
                self.executable = installed
        self.child = None
        self.lock = threading.Lock()

    @property
    def state(self):
        return self.root / 'state'

    def extension_folder(self):
        archive = self.resources / 'syncup-extension.zip'
        fingerprint = hashlib.sha256(archive.read_bytes()).hexdigest()
        target = self.root / 'extensions' / fingerprint[:16]
        desktop_setup.private_dir(target.parent)
        if not target.exists():
            desktop_setup.unpack_extension(archive, target)
        return target

    def status(self):
        saved = key_setup.status(self.state)
        teams = []
        if saved['keyPresent']:
            connection = key_setup.saved_connection(self.state)
            me = TeamClient(connection['api_url'], self.state / key_setup.KEY_FILE).me()
            teams = me.get('teams', [])
        return dict(web_url=self.config['web_url'], team_api=self.config['team_api'],
                    version=self.config['version'], installed=self.executable is not None,
                    key_present=saved['keyPresent'], running=self.child is not None and self.child.poll() is None,
                    teams=teams)

    def install(self, extension_id):
        if not isinstance(extension_id, str) or not desktop_setup.EXTENSION_ID.fullmatch(extension_id):
            raise ValueError('확장 ID 32자를 확인해 주세요.')
        executable = desktop_setup.copy_runtime(self.source, self.relative, self.root)
        result = desktop_setup.register(extension_id, executable, self.root, self.config['team_api'], self.home,
                                        local_demo=self.config.get('local_demo') is True)
        self.executable = executable
        pointer = self.root / 'installation.json'
        staged = self.root / ('installation-' + uuid.uuid4().hex + '.json')
        staged.write_text(json.dumps({'executable': str(executable)}), encoding='utf-8')
        if sys.platform != 'win32':
            staged.chmod(0o600)
        os.replace(staged, pointer)
        return dict(installed=True, backed_up=result['backup'] is not None)

    def start(self, team_id, api_key=''):
        if self.child is not None and self.child.poll() is None:
            raise ValueError('수집기가 실행 중이에요. 팀이나 AI 키를 바꾸려면 먼저 수집기를 중지해 주세요.')
        if self.executable is None:
            # A later launch of the installed app does not need to register again.
            if getattr(sys, 'frozen', False) and Path(sys.executable).is_relative_to(self.root / 'versions'):
                self.executable = Path(sys.executable)
            else:
                raise ValueError('먼저 이 PC에 연결 프로그램을 설치해 주세요.')
        if not key_setup.status(self.state)['keyPresent']:
            raise ValueError('GitHub로 이 PC를 연결한 뒤 다시 눌러 주세요.')
        try:
            selected = str(uuid.UUID(team_id))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('사용할 팀을 선택해 주세요.') from None
        if not isinstance(api_key, str) or len(api_key) > 2048 or any(ord(c) < 32 for c in api_key):
            raise ValueError('AI 키 입력을 확인해 주세요.')
        desktop_setup.private_dir(self.root / 'web-project')
        env = child_environment()
        if api_key.strip():
            env['OPENAI_API_KEY'] = api_key.strip()
        command = [str(self.executable), 'run', '--integrated', '--browser-only', '--start-paused',
                   '--state', str(self.state), '--project', str(self.root / 'web-project'),
                   '--port', '0', '--team-id', selected]
        flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
        self.child = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, **flags)
        # A live process alone is not readiness: wait for an authenticated RPC response from the collector.
        from native_host import request
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and self.child.poll() is None:
            try:
                result = request(self.state / 'connection.json', {'version': 1, 'method': 'collection.status', 'params': {}})
                if result.get('ok'):
                    return dict(running=True)
            except (OSError, ValueError):
                pass
            time.sleep(.2)
        self.stop()
        raise ValueError('수집기를 시작하지 못했어요. 인터넷 연결과 GitHub 연결을 확인해 주세요.')

    def stop(self):
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)
        return dict(running=False)


class SetupServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, state):
        super().__init__(('127.0.0.1', 0), SetupHandler)
        self.state = state
        self.secret = secrets.token_urlsafe(32)
        self.cookie_name = 'syncup_setup_' + secrets.token_hex(8)
        self.bootstrap = secrets.token_urlsafe(32)
        self.bootstrap_lock = threading.Lock()
        self.origin = f'http://127.0.0.1:{self.server_port}'

    def browser_url(self):
        with self.bootstrap_lock:
            self.bootstrap = secrets.token_urlsafe(32)
            return self.origin + '/open/' + self.bootstrap

    def consume_bootstrap(self, path):
        with self.bootstrap_lock:
            if self.bootstrap and secrets.compare_digest(path.encode('utf-8'), ('/open/' + self.bootstrap).encode('ascii')):
                self.bootstrap = None
                return True
        return False


class SetupHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, body, mime='application/json; charset=utf-8', headers=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def valid_host(self):
        return self.headers.get('Host') == self.server.origin.removeprefix('http://')

    def authorized(self):
        from http.cookies import SimpleCookie
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            value = cookie.get(self.server.cookie_name)
            return value is not None and secrets.compare_digest(value.value, self.server.secret)
        except (ValueError, TypeError):
            return False

    def do_GET(self):
        if not self.valid_host():
            return self.reply(403, {})
        if self.server.consume_bootstrap(self.path):
            return self.reply(303, b'', headers={'Location': '/', 'Set-Cookie':
                f'{self.server.cookie_name}={self.server.secret}; HttpOnly; SameSite=Strict; Path=/'})
        if not self.authorized():
            return self.reply(403, {'error': 'SyncUp 앱에서 설치 화면을 다시 열어 주세요.'})
        if self.path == '/':
            return self.reply(200, (self.server.state.resources / 'desktop.html').read_bytes(), 'text/html; charset=utf-8')
        if self.path == '/app.js':
            return self.reply(200, (self.server.state.resources / 'desktop.js').read_bytes(), 'text/javascript; charset=utf-8')
        if self.path in ('/desktop-assets/chrome-extensions.png', '/desktop-assets/chrome-syncup-id.png'):
            screenshot = self.server.state.resources / self.path.removeprefix('/')
            return self.reply(200, screenshot.read_bytes(), 'image/png')
        if self.path == '/status':
            try:
                return self.reply(200, self.server.state.status())
            except Exception:
                return self.reply(503, {'error': '팀 연결을 확인하지 못했어요. 인터넷 연결과 로그인 상태를 확인해 주세요.'})
        self.reply(404, {})

    def do_POST(self):
        if not self.valid_host() or not self.authorized() or self.headers.get('Origin') != self.server.origin:
            return self.reply(403, {})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192:
                return self.reply(413, {})
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                return self.reply(400, {})
            with self.server.state.lock:
                state = self.server.state
                if self.path == '/folder':
                    folder = state.extension_folder()
                    if sys.platform == 'darwin':
                        subprocess.Popen(['open', str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    else:
                        os.startfile(str(folder))
                    result = {'folder': str(folder)}
                elif self.path == '/install':
                    result = state.install(data.get('extension_id'))
                elif self.path == '/connect':
                    open_connection_in_chrome(state.config['web_url'] + '/connect')
                    result = {'opened': True}
                elif self.path == '/start':
                    result = state.start(data.get('team_id'), data.get('api_key', ''))
                elif self.path == '/stop':
                    result = state.stop()
                elif self.path == '/quit':
                    result = state.stop()
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                else:
                    return self.reply(404, {})
            self.reply(200, result)
        except ValueError as error:
            self.reply(400, {'error': str(error) if len(str(error)) < 150 else '입력 내용을 확인해 주세요.'})
        except Exception:
            self.reply(500, {'error': '설치를 완료하지 못했어요. 폴더 권한과 실행 파일을 확인해 주세요.'})


def main():
    os.umask(0o077)
    if not getattr(sys, 'frozen', False):
        raise SystemExit('배포용 SyncUp 앱을 실행하세요. 개발 검사는 checks/check_desktop_setup.py를 사용합니다.')
    executable = Path(sys.executable)
    resources = Path(sys._MEIPASS)
    if sys.platform == 'darwin' and executable.parent.name == 'MacOS':
        source, relative = executable.parents[2], Path('Contents/MacOS') / executable.name
    else:
        source, relative = executable.parent, Path(executable.name)
    state = DesktopState(resources, source, relative)
    with SetupServer(state) as server:
        try:
            if sys.platform == 'darwin':
                from desktop_macos import run
                run(server)
            else:
                webbrowser.open(server.browser_url())
                server.serve_forever()
        finally:
            state.stop()
