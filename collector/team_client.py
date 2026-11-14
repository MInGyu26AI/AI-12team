"""Device credentials stay in the local review process, never in the browser."""
import http.client
import json
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

from card_contract import validate_packet
from private_files import SECRET_TOKEN, read_private_file
from secure_http import NoRedirect

# The team server could not be reached or answered with an HTTP failure: offline, worth retrying.
TEAM_UNREACHABLE_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError)
# Any failure talking to the team server, including an answer this client refuses (ValueError: a changed user,
# a malformed or oversized response).
TEAM_ERRORS = (*TEAM_UNREACHABLE_ERRORS, ValueError)
RESPONSE_LIMIT = 4 * 1024 * 1024


def _uuid(value):
    """Canonical UUID text; ValueError for anything else."""
    return str(uuid.UUID(value))


class KeyFileError(ValueError):
    """The connection key file cannot be used; the message says why and how to fix it, without the key."""


def _key_not_private(path):
    if sys.platform == 'win32':
        # Codex on Windows grants its sandbox account (CodexSandboxUsers) read access to folders it touches.
        return (f'연결 키 파일에 다른 계정의 읽기 권한이 있습니다(예: Codex의 CodexSandboxUsers). '
                f'사용자 폴더 안에 두고 icacls "{path}" /reset 으로 기본 권한으로 되돌리세요.')
    return f'연결 키 파일은 현재 사용자만 읽을 수 있어야 합니다: chmod 600 "{path}"'


def read_key_file(token_file):
    """The connection key in token_file; KeyFileError when it is missing, readable by others or not a key."""
    path = Path(token_file)
    try:
        key = read_private_file(path, 256, _key_not_private(path))
    except OSError:
        raise KeyFileError(f'연결 키 파일을 열 수 없습니다. 경로를 확인하세요: {path}') from None
    except ValueError as error:
        raise KeyFileError(str(error)) from None
    token = key.decode('utf-8-sig', 'replace').strip()  # Windows editors may save a byte order mark
    if not SECRET_TOKEN.fullmatch(token):
        raise KeyFileError('연결 키 파일의 내용이 연결 키가 아닙니다. 받은 파일을 그대로 쓰세요.')
    return token


class TeamClient:
    def __init__(self, api_url, token_file, user_id=None):
        parsed = urllib.parse.urlsplit(api_url)
        if (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')
                or not parsed.hostname or parsed.scheme not in ('https', 'http')
                or (parsed.scheme == 'http' and parsed.hostname != '127.0.0.1')):
            raise ValueError('팀 API는 HTTPS 주소 또는 로컬 127.0.0.1 주소여야 합니다.')
        self.api_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '/', '', ''))
        self.token = read_key_file(token_file)
        # A previously bound identity enables local recovery, never remote authorization.
        self.user_id = None
        self.user_id = _uuid(user_id) if user_id is not None else self.me()['user_id']

    def request(self, path, data=None):
        request = urllib.request.Request(self.api_url + path,
            None if data is None else json.dumps(data, ensure_ascii=False).encode(),
            {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            response = opener.open(request, timeout=8)
        except urllib.error.HTTPError as error:
            error.close()
            raise
        with response:
            raw = response.read(RESPONSE_LIMIT + 1)
            if response.status != 200 or len(raw) > RESPONSE_LIMIT:
                raise ValueError('팀 API 응답 오류')
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError('팀 API 응답 형식 오류')
            return result

    def me(self):
        """The connected user and their teams. ValueError when the answer is malformed or names another user."""
        result = self.request('me')
        if not isinstance(result.get('user_id'), str):
            raise ValueError('연결 사용자 응답 오류')
        user_id = _uuid(result['user_id'])
        if user_id != result['user_id'] or (self.user_id is not None and user_id != self.user_id):
            raise ValueError('연결 사용자가 변경되었습니다.')
        teams = result.get('teams')
        if not isinstance(teams, list) or not isinstance(result.get('name'), str):
            raise ValueError('소속 팀 응답 오류')
        for team in teams:
            if (not isinstance(team, dict) or not isinstance(team.get('name'), str) or not isinstance(team.get('id'), str)
                    or _uuid(team['id']) != team['id']):
                raise ValueError('소속 팀 응답 오류')
        return result

    def publish(self, destination, payload, created):
        if destination['api_url'] != self.api_url or destination['user_id'] != self.user_id:
            raise ValueError('승인 당시의 서버와 사용자로 연결해야 합니다.')
        team_id = _uuid(destination['team_id'])
        packet = json.loads(payload)
        result = self.request('teams/' + team_id + '/items',
                              dict(packet=packet, approved_by=self.user_id, approved_at=created))
        if result != dict(id=packet['id'], team_id=team_id, approved_by=self.user_id):
            raise ValueError('팀 승인 응답 불일치')

    def items(self, team_id):
        team_id = _uuid(team_id)
        result = self.request('teams/' + team_id + '/items')
        if result.get('team_id') != team_id or not isinstance(result.get('items'), list):
            raise ValueError('팀 보드 응답 불일치')
        for item in result['items']:
            if not isinstance(item, dict):
                raise ValueError('팀 카드 응답 오류')
            validate_packet(item.get('packet'))
        return result['items']
