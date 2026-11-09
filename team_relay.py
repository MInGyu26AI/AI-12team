"""Team relay: forward the web's team.* requests through the local team client, scoped to the bound team."""
from urllib.parse import quote

from storage import connect

READ_PATHS = {'team.board': 'board', 'team.history': 'history', 'team.conflicts': 'conflicts',
              'team.conflictHistory': 'conflicts/history', 'team.done': 'todos/done'}
WRITE_METHODS = ('team.resolve', 'team.setDone', 'team.retryCheck')


def _write_request(method, params):
    """(path, body) of a write on one conflict or card."""
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
        team_id = c.execute('SELECT team_id FROM sharing').fetchone()[0]
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
