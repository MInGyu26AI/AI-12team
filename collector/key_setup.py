"""A teammate's team connection key from their GitHub login on the web, saved by the native host (native_host.py).

Chrome starts the native host for every message, so this works while the collector is off (docs/running.md).

    setup.status   whether this PC has a key and until when
    setup.begin    keep a new PKCE verifier in the state folder; the web gets only its S256 challenge
    setup.connect  with the one-time code Supabase returned to the web: generate the key here, register its SHA-256 at
                   the team server's POST /keys together with the code and verifier (server/key_issue.py), check it
                   with GET /me, and save team.key and team.json

The state folder is the folder of the connection.json the native host was registered with. The key and the verifier
stay in it and in the one request to the team server; no answer carries them or a path. The code the browser saw is
useless without the verifier.
"""
import base64
from contextlib import closing
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.request
import uuid

from private_files import make_private_directory, read_private_file
from secure_http import NoRedirect
from team_client import TEAM_ERRORS, KeyFileError, TeamClient, read_key_file, team_api_url

KEY_FILE, SAVED_FILE, PENDING_FILE = 'team.key', 'team.json', 'login.pending'
PENDING_SECONDS = 600  # a login started longer ago than this starts over
POST_SECONDS = 15  # each of at most two tries; with GET /me (8 s) the web's 45-second wait covers it
FILE_LIMIT = 4096
RESPONSE_LIMIT = 64 * 1024
CODE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
VERIFIER = re.compile(r'[A-Za-z0-9_-]{43,128}')

START_AGAIN = '로그인을 처음부터 다시 시작하세요. 시작한 지 10분이 지났거나 다른 창에서 다시 시작했습니다.'
NO_TEAM_API = ('이 PC의 연결 프로그램에 팀 서버 주소가 없습니다. '
               'native-setup을 --team-api와 함께 새 빈 폴더로 다시 하세요 (docs/running.md).')
FOLDER = '상태 폴더를 현재 사용자 전용으로 쓸 수 없습니다. 새 빈 상태 폴더로 native-setup을 다시 하세요.'
OTHER_SERVER = '이 상태 폴더는 다른 팀 서버에 연결돼 있습니다. 새 빈 상태 폴더로 native-setup을 다시 하세요.'
OTHER_USER = ('이 PC는 다른 SyncUp 사용자로 연결돼 있습니다. 본인 GitHub 계정으로 로그인했는지 확인하세요. '
              '사용자를 바꾸려면 새 빈 상태 폴더로 native-setup을 다시 하세요.')
ANSWERS = {
    400: '요청 형식이 맞지 않습니다. 확장과 수집기를 최신으로 바꾸세요.',
    401: '로그인이 만료되었거나 이미 사용되었습니다. 처음부터 다시 로그인하세요.',
    403: '관리자 확인이 필요한 계정입니다. 팀 관리자에게 GitHub 계정 등록을 요청하세요.',
    404: '팀 서버에서 웹 연결 키 발급이 아직 켜지지 않았습니다. 팀 관리자에게 문의하세요.',
    409: '연결된 PC가 너무 많습니다. 팀 관리자에게 이전 PC의 키 폐기를 요청하세요.',
    429: '잠시 뒤 다시 시도하세요.',
}
SERVER_FAILED = '팀 서버가 연결 키를 등록하지 못했습니다. 잠시 뒤 다시 시도하세요.'
UNREACHABLE = '팀 서버에 닿지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.'
NOT_SAVED = '연결 키를 이 PC에 저장하지 못했습니다. 상태 폴더를 확인하고 다시 시도하세요.'


class SetupError(Exception):
    """A fixed message for the web page; never holds the key, the code, the verifier or a path."""


def handle(connection, team_api, payload):
    """The native host's answer to one setup.* request: {ok, result} or {ok: false, error}."""
    try:
        if (not isinstance(payload, dict) or set(payload) != {'version', 'method', 'params'} or payload['version'] != 1
                or not isinstance(payload['params'], dict)):
            raise SetupError('요청 형식이 맞지 않습니다. 확장을 최신으로 바꾸세요.')
        state = Path(connection).parent
        method, params = payload['method'], payload['params']
        if method == 'setup.status':
            result = status(state)
        elif method == 'setup.begin':
            result = begin(state)
        elif method == 'setup.connect':
            result = connect(state, team_api, params.get('code'))
        else:
            raise SetupError('지원하지 않는 연결 요청입니다.')
        return dict(ok=True, result=result)
    except SetupError as error:
        return dict(ok=False, error=str(error))
    except (OSError, ValueError, sqlite3.Error):
        return dict(ok=False, error=NOT_SAVED)


def status(state):
    """Whether this PC has a saved key, and when it expires; nothing is created."""
    try:
        saved = saved_connection(state)
    except ValueError:
        saved = None
    present = saved is not None and (state / KEY_FILE).is_file()
    return dict(hostReady=True, keyPresent=present, expiresAt=saved['expires_at'] if present else None)


def begin(state):
    """A new login: its verifier replaces any earlier one, so only the latest login of this PC can finish."""
    prepare_state(state)
    verifier = secrets.token_urlsafe(64)
    write_private(state / PENDING_FILE, json.dumps(dict(verifier=verifier, at=time.time())))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return dict(challenge=challenge)


def connect(state, team_api, code):
    if not isinstance(code, str) or not CODE.fullmatch(code):
        raise SetupError(START_AGAIN)
    try:
        team_api = team_api_url(team_api or '')
    except ValueError:
        raise SetupError(NO_TEAM_API) from None
    prepare_state(state)
    verifier = take_pending(state)
    expected_user, replaces = None, None
    try:
        saved = saved_connection(state)
    except ValueError:
        raise SetupError(FOLDER) from None
    bound = bound_sharing(state)
    for known in (saved, bound):
        if known and known['api_url'] != team_api:
            raise SetupError(OTHER_SERVER)
        expected_user = expected_user or (known and known['user_id'])
    if saved and (state / KEY_FILE).is_file():
        try:
            replaces = hashlib.sha256(read_key_file(state / KEY_FILE).encode()).hexdigest()
        except KeyFileError:
            replaces = None
    key = secrets.token_urlsafe(32)
    body = dict(code=code, verifier=verifier, digest=hashlib.sha256(key.encode()).hexdigest(),
                device='Windows' if sys.platform == 'win32' else 'macOS')
    if replaces:
        body['replaces'] = replaces
    new_key = new_private_file(state, KEY_FILE, key + '\n')
    try:
        issued = register(team_api, body)
        if expected_user and issued['user_id'] != expected_user:
            raise SetupError(OTHER_USER)
        try:
            profile = TeamClient(team_api, new_key, issued['user_id']).me()
        except TEAM_ERRORS:
            raise SetupError(SERVER_FAILED) from None
        replace_file(new_key, state / KEY_FILE)
    except BaseException:
        _remove(new_key)
        raise
    write_private(state / SAVED_FILE, json.dumps(dict(api_url=team_api, user_id=issued['user_id'],
                                                      expires_at=issued['expires_at'])))
    return dict(name=profile['name'], teams=[team['name'] for team in profile['teams']], expiresAt=issued['expires_at'])


def register(team_api, body):
    """The team server's {user_id, name, expires_at} for this key. A lost answer is retried once with the same digest,
    which the server answers from the key it already registered."""
    for attempt in (1, 2):
        call = urllib.request.Request(team_api + 'keys', json.dumps(body).encode(),
                                      {'Content-Type': 'application/json'}, method='POST')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(call, timeout=POST_SECONDS) as response:
                raw = response.read(RESPONSE_LIMIT + 1)
                answered = response.status
        except urllib.error.HTTPError as error:
            error.close()
            raise SetupError(ANSWERS.get(error.code, SERVER_FAILED)) from None
        except (urllib.error.URLError, http.client.HTTPException, OSError):
            if attempt == 2:
                raise SetupError(UNREACHABLE) from None
            continue
        try:
            issued = json.loads(raw) if answered == 200 and len(raw) <= RESPONSE_LIMIT else None
            if (isinstance(issued, dict) and str(uuid.UUID(issued['user_id'])) == issued['user_id']
                    and isinstance(issued['name'], str) and isinstance(issued['expires_at'], str)):
                return issued
        except (ValueError, KeyError, TypeError):
            pass
        raise SetupError(SERVER_FAILED)


def saved_connection(state):
    """{api_url, user_id, expires_at} of team.json in state, or None when there is none. ValueError when it is
    readable by others or malformed: the collector would otherwise send the key wherever that file points."""
    try:
        raw = read_private_file(Path(state) / SAVED_FILE, FILE_LIMIT + 1, 'team.json은 현재 사용자만 읽을 수 있어야 합니다.')
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ValueError('team.json을 읽을 수 없습니다.') from error
    try:
        saved = json.loads(raw)
        if (len(raw) <= FILE_LIMIT and isinstance(saved, dict) and set(saved) == {'api_url', 'user_id', 'expires_at'}
                and team_api_url(saved['api_url']) == saved['api_url'] and isinstance(saved['expires_at'], str)
                and str(uuid.UUID(saved['user_id'])) == saved['user_id']):
            return saved
    except (ValueError, TypeError, AttributeError):
        pass
    raise ValueError('team.json 형식이 맞지 않습니다. 배포 웹 /connect에서 연결 키를 다시 받으세요.')


def bound_sharing(state):
    """The team server and user this state folder's collector is already bound to (collection_session.bind_sharing),
    or None; read-only, and never creates the database."""
    db = Path(state) / 'private.sqlite'
    if not db.is_file():
        return None
    try:
        with closing(sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as c:
            row = c.execute('SELECT api_url, user_id FROM sharing').fetchone()
    except sqlite3.Error:
        return None
    return dict(api_url=row[0], user_id=row[1]) if row else None


def prepare_state(state):
    """Create the state folder for the current user only, or check that an existing one is; and keep Git out of it."""
    try:
        if sys.platform == 'win32':
            make_private_directory(state)  # an empty folder gets an owner-only ACL that new files inherit
        else:
            state.mkdir(mode=0o700, parents=True, exist_ok=True)
            info = os.lstat(state)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise SetupError(FOLDER)
        ignore = state / '.gitignore'
        if not ignore.exists():  # a state folder inside a repository must never get its key committed
            write_private(ignore, '*\n')
    except OSError:
        raise SetupError(FOLDER) from None


def take_pending(state):
    """The verifier setup.begin kept, removed as it is read so that a code can be redeemed only once."""
    path = state / PENDING_FILE
    try:
        raw = read_private_file(path, FILE_LIMIT + 1, FOLDER)
    except FileNotFoundError:
        raise SetupError(START_AGAIN) from None
    except (OSError, ValueError):
        _remove(path)
        raise SetupError(FOLDER) from None
    _remove(path)
    try:
        pending = json.loads(raw)
        verifier, started = pending['verifier'], pending['at']
        fresh = isinstance(started, (int, float)) and 0 <= time.time() - started <= PENDING_SECONDS
        if isinstance(verifier, str) and VERIFIER.fullmatch(verifier) and fresh:
            return verifier
    except (ValueError, KeyError, TypeError):
        pass
    raise SetupError(START_AGAIN)


def new_private_file(folder, name, text):
    """A new file next to `name` holding text, only the current user can read it (the collector's own check)."""
    path = folder / f'.{name}.{secrets.token_hex(6)}.new'
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(text.encode())
        read_private_file(path, len(text.encode()) + 1, FOLDER)
    except ValueError:
        _remove(path)
        raise SetupError(FOLDER) from None
    except BaseException:
        _remove(path)
        raise
    return path


def write_private(path, text):
    written = new_private_file(path.parent, path.name, text)
    try:
        replace_file(written, path)
    except BaseException:
        _remove(written)
        raise


def replace_file(source, target):
    """os.replace, retried briefly on Windows, where another program holding the target open refuses it."""
    for attempt in range(4):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if sys.platform != 'win32' or attempt == 3:
                raise
            time.sleep(.5)


def _remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
