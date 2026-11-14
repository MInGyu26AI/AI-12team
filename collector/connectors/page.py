"""The /connectors page of the collector's local web page: connect a service, choose what to read, read now.

review_page.Review routes to get() and submit() (only wiring there). The page is served on 127.0.0.1 like the review
page; review_page has already checked the Host, the Origin and the csrf token of a POST before submit() runs, and
checked the Host of a GET. Provider forms are posted here and never to the deployed web, so tokens are typed into this
page only, and they are never shown again: a value of the service's token file is scrubbed from every provider text.
"""
from __future__ import annotations

from datetime import datetime
import urllib.parse

from connectors import base
from diagnostics import failure
from review_render import esc, page

CALLBACK = '/connectors/callback/'
NOTE = ('이 PC에서만 읽습니다. 연결 정보(토큰)는 이 PC의 상태 폴더에만 저장되고 팀 서버나 다른 곳으로 보내지 않습니다. '
        '가져온 글은 다른 대화와 똑같이 가림 처리와 이 기기의 개인정보 검사, 개인 검토함의 승인을 거치고, '
        '승인한 카드만 팀 서버로 갑니다. 수집이 일시중지되거나 종료되면 읽지 않습니다.')


def _time(iso):
    return datetime.fromisoformat(iso).astimezone().strftime('%m/%d %H:%M') if iso else '아직 안 함'


def _hidden(csrf, **values):
    return f'<input type="hidden" name="csrf" value="{esc(csrf)}">' + ''.join(
        f'<input type="hidden" name="{name}" value="{esc(value)}">' for name, value in values.items())


def _scope_html(scope, connected, csrf):
    site, scope_id = scope['site'], scope['scopeId']
    state = '켜짐' if scope['enabled'] else '꺼짐'
    problem = f' · 오류 {esc(scope["lastError"])}' if scope['lastError'] else ''
    sync = (f'<form method="post" action="/connectors/sync">{_hidden(csrf, site=site, scope_id=scope_id)}'
            f'<button {"" if scope["enabled"] and connected else "disabled"}>지금 가져오기</button></form>')
    toggle = (f'<form method="post" action="/connectors/scope">'
              f'{_hidden(csrf, site=site, scope_id=scope_id, enabled="0" if scope["enabled"] else "1")}'
              f'<button>{"끄기" if scope["enabled"] else "켜기"}</button></form>')
    return (f'<div><strong>{esc(scope["title"] or scope_id)}</strong> <small>{esc(scope_id)} · {state}</small><br>'
            f'<small>마지막 확인 {esc(_time(scope["lastRun"]))} · 가져온 글 {scope["imported"]}개{problem}</small>'
            f'<div class="actions">{toggle}{sync}</div></div>')


def _provider_html(pipeline, provider, scopes, csrf):
    status = base.provider_status(pipeline, provider)
    html = (f'<article><h2>{esc(provider.label)}</h2><p><span class="state">{"연결됨" if status["connected"] else "연결 필요"}'
            f'</span> {esc(status["needs"] or "")}</p>')
    try:
        fields = base.scrub(pipeline, provider.site, provider.setup_html(pipeline))
    except Exception as error:
        failure('connectors_page', error)
        fields = ''
    if fields:
        html += (f'<form method="post" action="/connectors/setup">{_hidden(csrf, site=provider.site)}{fields}'
                 '<button>저장</button></form>')
    html += ''.join(_scope_html(s, status['connected'], csrf) for s in scopes) or '<p class="note">읽을 범위를 아직 고르지 않았습니다.</p>'
    html += (f'<details><summary>범위 추가</summary><form method="post" action="/connectors/scope">'
             f'{_hidden(csrf, site=provider.site, enabled="1")}'
             '<label>범위 id (서비스가 주는 문서·페이지 id)<input name="scope_id" required maxlength="300"></label>'
             '<label>이름 (선택)<input name="title" maxlength="200"></label><button>추가</button></form></details>')
    if status['tokenSet']:
        html += (f'<form method="post" action="/connectors/disconnect">{_hidden(csrf, site=provider.site)}'
                 '<button>연결 끊기 (이 PC의 연결 정보 삭제)</button></form>')
    return html + '</article>'


def render(server, pipeline, message=None, failed=False):
    """The whole page; message is the answer to the action just done."""
    csrf = server.csrf
    providers = base.load_providers().values()
    scopes = {}
    for row in base.list_scopes(pipeline):
        scopes.setdefault(row['site'], []).append(base.scope_info(row))
    body = ('<nav><b>싱크업</b><a href="/">개인 검토함</a></nav><header><h1>외부 서비스 연결</h1></header>'
            f'<p class="note">{esc(NOTE)}</p>')
    if message:
        body += f'<p role="{"alert" if failed else "status"}">{esc(message)}</p>'
    if not providers:
        body += '<article>연결할 수 있는 서비스가 아직 없습니다.</article>'
    body += ''.join(_provider_html(pipeline, p, scopes.get(p.site, []), csrf) for p in providers)
    return page('외부 서비스 연결', body)


def _respond(server, pipeline, site, run):
    """(status, html): the page after run() ran, with its message or the reason it failed (no provider text but the
    scrubbed ValueError messages providers write for the user; other failures show their kind only)."""
    failed = False
    try:
        message = run()
        status = 200
    except ValueError as error:
        message, status, failed = str(error), 400, True
    except Exception as error:
        failure('connectors_page', error)
        message, status, failed = f'처리하지 못했습니다 ({base.error_kind(error)}).', 503, True
    if isinstance(site, str) and base.SITE_NAME.fullmatch(site):
        message = base.scrub(pipeline, site, message)
    return status, render(server, pipeline, message, failed)


def _setup(pipeline, form):
    provider = base.provider_for(form.get('site'))
    return provider.handle_setup(pipeline, {k: v for k, v in form.items() if k != 'site'})


def _scope(pipeline, form):
    enabled = {'1': True, '0': False}.get(form.get('enabled'))
    if enabled is None:
        raise ValueError('사용 여부를 확인하세요.')
    info = base.set_scope(pipeline, form.get('site'), form.get('scope_id', ''), form.get('title'), enabled)
    return f'범위를 {"켰" if info["enabled"] else "껐"}습니다: {info["title"] or info["scopeId"]}'


def _sync(pipeline, form):
    results = base.run_selected(pipeline, form.get('site') or None, form.get('scope_id') or None)
    if not results:
        return '가져올 범위가 없습니다. 서비스를 연결하고 범위를 켜 두세요.'
    failed = [r for r in results if 'error' in r]
    message = (f'가져왔습니다: 새 글 {sum(r["sent"] for r in results)}개, '
               f'이미 가져온 글 {sum(r["skipped"] for r in results)}개.')
    if failed:
        message += ' 오류 ' + ', '.join(f'{r["scopeId"]}: {r["error"]}' for r in failed) + '.'
    return message


def _disconnect(pipeline, form):
    provider = base.disconnect(pipeline, form.get('site'))
    return f'{provider.label} 연결을 끊고 이 PC의 연결 정보를 지웠습니다. 서비스 쪽 권한은 그 서비스 설정에서도 지우세요.'


ACTIONS = {'/connectors/setup': _setup, '/connectors/scope': _scope, '/connectors/sync': _sync,
           '/connectors/disconnect': _disconnect}


def submit(server, pipeline, path, fields):
    """(status, html) of a POST under /connectors; fields is parse_qs output of the already csrf-checked form."""
    action = ACTIONS.get(path)
    if action is None:
        return 404, '찾을 수 없습니다.'
    form = {k: v[0] for k, v in fields.items() if k != 'csrf' and v}
    return _respond(server, pipeline, form.get('site'), lambda: action(pipeline, form))


def get(server, pipeline, path):
    """(status, html) of a GET under /connectors: the page, or the browser coming back from a service's login."""
    parsed = urllib.parse.urlsplit(path)
    if parsed.path == '/connectors':
        return 200, render(server, pipeline)
    if parsed.path.startswith(CALLBACK):
        site = parsed.path[len(CALLBACK):]
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items() if v}
        return _respond(server, pipeline, site, lambda: base.provider_for(site).handle_callback(pipeline, query))
    return 404, '페이지를 찾을 수 없습니다.'
