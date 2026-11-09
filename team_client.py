"""Device credentials stay in the local review process, never in the browser."""
import http.client
import json
import os
from pathlib import Path
import re
import stat
import urllib.error
import urllib.parse
import urllib.request
import uuid

from card_contract import validate_packet
from delivery import NoRedirect


NETWORK_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError, ValueError)
RESPONSE_LIMIT = 4 * 1024 * 1024


class TeamClient:
    def __init__(self, api_url, token_file, user_id=None):
        parsed = urllib.parse.urlsplit(api_url)
        if (parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')
                or not parsed.hostname or parsed.scheme not in ('https', 'http')
                or (parsed.scheme == 'http' and parsed.hostname != '127.0.0.1')):
            raise ValueError('팀 API는 HTTPS 주소 또는 로컬 127.0.0.1 주소여야 합니다.')
        self.api_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '/', '', ''))
        fd = os.open(Path(token_file), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'r', encoding='utf-8') as f:
            info = os.fstat(f.fileno())
            if not stat.S_ISREG(info.st_mode) or (os.name == 'posix' and
                    (info.st_mode & 0o077 or info.st_uid != os.getuid())):
                raise ValueError('연결 키 파일은 현재 사용자만 읽을 수 있어야 합니다 (권한 600).')
            self.token = f.read(256).strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', self.token):
            raise ValueError('연결 키 파일을 확인하세요.')
        # A previously bound identity enables local recovery, never remote authorization.
        self.user_id = str(uuid.UUID(user_id)) if user_id is not None else self.me()['user_id']

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
        result = self.request('me')
        if not isinstance(result.get('user_id'), str):
            raise ValueError('연결 사용자 응답 오류')
        user_id = str(uuid.UUID(result.get('user_id', '')))
        if user_id != result['user_id'] or (hasattr(self, 'user_id') and user_id != self.user_id):
            raise ValueError('연결 사용자가 변경되었습니다.')
        teams = result.get('teams')
        if not isinstance(teams, list) or not isinstance(result.get('name'), str):
            raise ValueError('소속 팀 응답 오류')
        for team in teams:
            if (not isinstance(team, dict) or not isinstance(team.get('name'), str) or not isinstance(team.get('id'), str)
                    or str(uuid.UUID(team.get('id', ''))) != team['id']):
                raise ValueError('소속 팀 응답 오류')
        return result

    def publish(self, destination, payload, created):
        if destination['api_url'] != self.api_url or destination['user_id'] != self.user_id:
            raise ValueError('승인 당시의 서버와 사용자로 연결해야 합니다.')
        team_id = str(uuid.UUID(destination['team_id']))
        result = self.request('teams/' + team_id + '/items',
                              dict(packet=json.loads(payload), approved_by=self.user_id, approved_at=created))
        if result != dict(id=json.loads(payload)['id'], team_id=team_id, approved_by=self.user_id):
            raise ValueError('팀 승인 응답 불일치')

    def items(self, team_id):
        team_id = str(uuid.UUID(team_id))
        result = self.request('teams/' + team_id + '/items')
        if result.get('team_id') != team_id or not isinstance(result.get('items'), list):
            raise ValueError('팀 보드 응답 불일치')
        for item in result['items']:
            if not isinstance(item, dict):
                raise ValueError('팀 카드 응답 오류')
            validate_packet(item.get('packet'))
        return result['items']


def bind_sharing(c, client, team_id=None, profile=None):
    profile = client.me() if profile is None else profile
    if profile['user_id'] != client.user_id:
        raise ValueError('연결 사용자가 변경되었습니다.')
    existing = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
    if existing and (existing['api_url'] != client.api_url or existing['user_id'] != client.user_id):
        raise ValueError('사용자나 팀 서버를 바꾸려면 별도 상태 폴더를 사용하세요.')
    if team_id is not None and team_id not in {t['id'] for t in profile['teams']}:
        raise ValueError('선택한 팀의 구성원이 아닙니다.')
    if not existing:
        c.execute('INSERT INTO sharing VALUES(1,?,?,?)', (client.api_url, client.user_id, team_id))
    elif team_id is not None:
        c.execute('UPDATE sharing SET team_id=? WHERE id=1', (team_id,))
    return profile
