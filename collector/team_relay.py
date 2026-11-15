"""Team relay: forward the web's team.* requests through the local team client, scoped to the bound team."""
from urllib.parse import quote

from collection_session import bound_team
from storage import connect

READ_PATHS = {'team.board': 'board', 'team.history': 'history', 'team.conflicts': 'conflicts',
              'team.conflictHistory': 'conflicts/history', 'team.done': 'todos/done', 'team.repo': 'repo',
              'team.settings': 'settings'}
WRITE_METHODS = ('team.resolve', 'team.setDone', 'team.retryCheck', 'team.updateSettings',
                 'team.verifyRepo', 'team.linkRepo', 'team.unlinkRepo')
# team.updateSettings fields (server/team_settings.py). A topic changed here reaches this collector's own
# classification through sync_team_topic; collection.configure is the path that changes it locally at once.
SETTINGS_FIELDS = ('topic', 'goal', 'scope', 'rules')
# The team's GitHub link (server/repo_sync.py link_request): (path, allowed fields). The token passes through to the
# team server only; nothing here stores or logs it.
REPO_WRITES = {'team.verifyRepo': ('repo/verify', ('repo', 'branch', 'token')),
               'team.linkRepo': ('repo', ('repo', 'branch', 'token', 'acceptPublic')),
               'team.unlinkRepo': ('repo/unlink', ())}


def _write_request(method, params):
    """(path, body) of a write on one conflict or card, the team settings or the team's GitHub link."""
    if method in REPO_WRITES:
        path, fields = REPO_WRITES[method]
        if set(params) - set(fields):
            raise ValueError('레포 연결 필드 오류')
        return path, {k: params[k] for k in fields if k in params}
    if method == 'team.updateSettings':
        body = {k: params[k] for k in SETTINGS_FIELDS if k in params}
        if not body or set(params) - set(SETTINGS_FIELDS):
            raise ValueError('팀 설정 필드 오류')
        return 'settings', body
    if not (isinstance(params.get('id'), str) and params['id']):
        raise ValueError('팀 요청 대상 id가 없습니다.')  # never send a request such as 'items/None/done'
    target = quote(params['id'], safe='')
    if method == 'team.resolve':
        body = dict(resolution=params.get('resolution'), resolutionNote=params.get('resolutionNote', ''))
        return f'conflicts/{target}/resolve', body
    if method == 'team.setDone':
        return f'items/{target}/done', dict(done=params.get('done'))
    return f'items/{target}/retry-check', {}


def relay(pipeline, method, params):
    with connect(pipeline.db) as c:
        team_id = bound_team(c)
    if method in WRITE_METHODS:
        path, data = _write_request(method, params)
    elif method in READ_PATHS:
        path, data = READ_PATHS[method], None
    else:
        raise ValueError('지원하지 않는 팀 요청입니다.')
    if not team_id:
        raise ValueError('공유할 팀을 먼저 선택하세요.')
    result = pipeline.client.request(f'teams/{team_id}/{path}', data)
    if result.get('team_id') != team_id:
        raise ValueError('대상 팀 응답 불일치')
    return result
