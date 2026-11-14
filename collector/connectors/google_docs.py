"""The Google Docs provider (docs/connectors.md): read the documents whose address the user pasted, on this PC.

    OAuth: the user's own Google Cloud "Desktop app" client; the browser comes back to
           http://127.0.0.1:<port>/connectors/callback/google-docs (PKCE S256, a state bound to the pending login)
    Scope: documents.readonly (Docs API; a sensitive scope that works for test users while the app is in Testing mode).
           drive.file + Google Picker would need a registered JavaScript origin that 127.0.0.1 may not get, so the
           user pastes the address of each document instead.
    Author: the Docs API has no author per paragraph, so every section says author_is_me=None and a document is only
            read after the user ticked "이 문서의 담당자로서 가져오기" for it (docs/connectors.md, "내 글만").

Everything lives in <state>/connectors/google-docs.json (base.save_token, mode 0600):
    client_id, client_secret            the user's OAuth client (a Desktop client's secret is not confidential, but never shown)
    refresh_token, access_token, expires_at
    pending {verifier, expires_at}      a login in progress (10 minutes); the state value is derived from the verifier
    owner {doc id: true|false}          documents the user confirmed to own
    reauth                              the refresh token was refused (invalid_grant): connect again

The provider keeps no state of its own, so a second instance (or a restart) behaves the same.
The framework scrubs every long string of that file from the page, so what the page must show about it is built so
the stored text never appears literally: the state is not stored (it is derived), and the client id in the consent
link is percent-encoded character by character.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import hmac
from html import escape
import http.client
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from connectors import base
from secure_http import NoRedirect
from turn_intake import TEAM_RECORD_HEAD

SITE = 'google-docs'
CALLBACK = '/connectors/callback/google-docs'
SCOPE = 'https://www.googleapis.com/auth/documents.readonly'
ENDPOINTS = dict(  # name -> (environment variable that replaces it in tests, default)
    auth=('SYNCUP_GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    token=('SYNCUP_GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    docs=('SYNCUP_GOOGLE_DOCS_API', 'https://docs.googleapis.com/v1'),
    revoke=('SYNCUP_GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke'))
LOOPBACK = ('127.0.0.1', 'localhost', '::1')
PENDING_SECONDS = 600  # a login link works for ten minutes
REFRESH_MARGIN = 60  # an access token that expires within this many seconds is renewed first
RETRY_DELAYS = (1.0, 2.0, 4.0)  # seconds to wait after each 429 before asking again (so up to four attempts)
MAX_RETRY_AFTER = 8.0
TIMEOUT = 30
REVOKE_TIMEOUT = 10
RESPONSE_LIMIT = 20 * 1024 * 1024
HEADING_STYLES = ('TITLE', 'HEADING_1', 'HEADING_2', 'HEADING_3')  # these start a new section

CLIENT_ID = re.compile(r'[A-Za-z0-9._-]{8,200}')
CLIENT_SECRET = re.compile(r'[A-Za-z0-9._~-]{8,200}')
DOC_ID = re.compile(r'[A-Za-z0-9_-]{10,200}')
BARE_DOC_ID = re.compile(r'[A-Za-z0-9_-]{20,200}')
DOC_URL = re.compile(r'https://docs\.google\.com/document/(?:u/\d+/)?d/([A-Za-z0-9_-]{10,200})(?:[/?#].*)?')

ConnectorError = base.ConnectorError
_LOCK = threading.RLock()  # the token file is read, changed and written by the page, the callback and the 5-minute run


# ---------------------------------------------------------------------------------------------------------------------
# HTTP: urllib only, no redirects, bounded answers, a bounded wait after 429; errors carry a kind and a status only

def _endpoint(name):
    variable, default = ENDPOINTS[name]
    url = os.environ.get(variable) or default
    parts = urllib.parse.urlsplit(url)
    secure = parts.scheme == 'https' or (parts.scheme == 'http' and parts.hostname in LOOPBACK)
    if not secure or not parts.hostname or parts.username or parts.password:
        raise ConnectorError('bad_endpoint')  # tokens go to https hosts (or a test server on this PC), nowhere else
    return url.rstrip('/') if name == 'docs' else url


def _opener(url):
    handlers = [NoRedirect()]
    if urllib.parse.urlsplit(url).hostname in LOOPBACK:
        handlers.insert(0, urllib.request.ProxyHandler({}))  # a proxy must never see traffic to this PC
    return urllib.request.build_opener(*handlers)


def _once(opener, request, timeout):
    """(status, raw bytes, Retry-After) of one request, whatever the HTTP status; ConnectorError('network') otherwise."""
    try:
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error  # an HTTPError is also a readable answer
        with response:
            return response.status, response.read(RESPONSE_LIMIT + 1), response.headers.get('Retry-After')
    except (OSError, http.client.HTTPException, ValueError):
        raise ConnectorError('network') from None


def _call(method, url, bearer=None, form=None, timeout=TIMEOUT):
    """(status, body) of one request: body is the JSON object of the answer ({} when it is empty or not an object).
    A 429 is asked again after a wait, at most len(RETRY_DELAYS) times; any other status is the caller's to judge."""
    headers = {'Accept': 'application/json', 'User-Agent': 'syncup-collector'}
    data = None
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    opener = _opener(url)
    for attempt in range(len(RETRY_DELAYS) + 1):
        status, raw, retry_after = _once(opener, urllib.request.Request(url, data, headers, method=method), timeout)
        if len(raw) > RESPONSE_LIMIT:
            raise ConnectorError('too_large')
        if status == 429 and attempt < len(RETRY_DELAYS):
            wait = RETRY_DELAYS[attempt]
            if retry_after and retry_after.isdigit():
                wait = min(float(retry_after), MAX_RETRY_AFTER)
            time.sleep(wait)
            continue
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {}
        return status, body if isinstance(body, dict) else {}


def _docs_error(status):
    kind = {401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 429: 'rate_limit'}.get(status)
    return ConnectorError(kind or ('server_error' if status >= 500 else 'http_error'), status)


def _explain(error):
    """A ConnectorError as the sentence the setup page shows (the scope's last_error keeps the short kind)."""
    kind = error.kind
    text = {
        'reauth_required': '구글 연결이 끝났습니다. 다시 연결하세요 (테스트 앱은 7일마다 만료).',
        'not_connected': '먼저 구글 계정을 연결하세요.',
        'invalid_grant': '로그인 코드가 맞지 않거나 만료되었습니다. “구글 계정 연결”을 다시 누르세요.',
        'invalid_client': '클라이언트 ID나 보안 비밀이 맞지 않습니다. 구글 Cloud의 값과 같은지 확인하세요.',
        'not_found': '문서를 찾을 수 없습니다. 주소와, 연결한 구글 계정이 이 문서를 열 수 있는지 확인하세요.',
        'forbidden': '이 계정으로 문서를 읽을 수 없습니다. 문서 공유와, 구글 Cloud에서 Google Docs API를 켰는지 확인하세요.',
        'unauthorized': '구글이 로그인 정보를 받아들이지 않았습니다. 다시 연결하세요.',
        'rate_limit': '구글이 요청이 많다고 답했습니다. 잠시 뒤 다시 시도하세요.',
        'network': '구글에 연결하지 못했습니다. 인터넷 연결을 확인하세요.',
    }.get(kind)
    return text or f'구글이 요청을 처리하지 못했습니다 ({base.error_kind(error)}).'


# ---------------------------------------------------------------------------------------------------------------------
# The token file

def _load(pipeline):
    return base.load_token(base.state_dir(pipeline), SITE)


def _edit(pipeline, change):
    """Read the file, let change(token) edit the dict, write it back; the new dict."""
    with _LOCK:
        token = _load(pipeline) or {}
        if not isinstance(token.get('owner'), dict):
            token['owner'] = {}
        change(token)
        base.save_token(base.state_dir(pipeline), SITE, token)
        return token


def _text(value):
    return value if isinstance(value, str) else ''


def _logged_in(token):
    return bool(token) and bool(_text(token.get('refresh_token')))


def _client(token):
    client_id, secret = _text((token or {}).get('client_id')), _text((token or {}).get('client_secret'))
    return (client_id, secret) if client_id and secret else None


def _pending(token):
    pending = (token or {}).get('pending')
    ok = (isinstance(pending, dict) and isinstance(pending.get('verifier'), str) and pending['verifier']
          and isinstance(pending.get('expires_at'), (int, float)))
    return pending if ok else None


def _drop_login(token):
    for key in ('refresh_token', 'access_token', 'expires_at', 'pending', 'reauth'):
        token.pop(key, None)


# ---------------------------------------------------------------------------------------------------------------------
# OAuth: consent link, code exchange, refresh

def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def _challenge(verifier):
    return _b64(hashlib.sha256(verifier.encode()).digest())


def _state(verifier):
    """The state value of a login: derived from its verifier, so it needs no place of its own in the file."""
    return _b64(hashlib.sha256(b'syncup-google-docs-state:' + verifier.encode()).digest())


def _percent(text):
    return ''.join(f'%{byte:02X}' for byte in text.encode())


def consent_url(pipeline, token):
    """The Google login address of the pending login, or None (nothing pending or expired, no client, no local page yet)."""
    pending, client = _pending(token), _client(token)
    redirect = base.local_page_url(pipeline, CALLBACK)
    if not pending or not client or not redirect or pending['expires_at'] <= time.time():
        return None
    query = urllib.parse.urlencode([
        ('redirect_uri', redirect), ('response_type', 'code'), ('scope', SCOPE), ('access_type', 'offline'),
        ('prompt', 'consent'), ('state', _state(pending['verifier'])), ('code_challenge', _challenge(pending['verifier'])),
        ('code_challenge_method', 'S256')], quote_via=urllib.parse.quote)
    url = _endpoint('auth')
    # The client id is spelled out in %XX: the page scrubs the file's own text, and this link must survive that.
    return f'{url}{"&" if "?" in url else "?"}client_id={_percent(client[0])}&{query}'


def _token_request(form):
    """The token endpoint's answer for an OAuth grant: the body with an access token, else ConnectorError."""
    status, body = _call('POST', _endpoint('token'), form=form)
    if status == 200 and isinstance(body.get('access_token'), str) and body['access_token']:
        return body
    error = body.get('error') if isinstance(body.get('error'), str) else ''
    if error == 'invalid_grant':
        raise ConnectorError('invalid_grant', status)
    if error in ('invalid_client', 'unauthorized_client') or status == 401:
        raise ConnectorError('invalid_client', status)
    raise ConnectorError('token_error', status)


def _lifetime(body):
    value = body.get('expires_in')
    seconds = value if isinstance(value, (int, float)) and not isinstance(value, bool) else 3600
    return min(max(seconds, 60), 86400)


def _access_token(pipeline, force=False):
    """A usable access token; the refresh token buys a new one when it expires within a minute (or force).
    invalid_grant (the 7-day end of a Testing app, a revoked grant) drops the login and says ConnectorError('reauth_required')."""
    with _LOCK:
        token = _load(pipeline) or {}
        refresh, client = _text(token.get('refresh_token')), _client(token)
        if not refresh or not client:
            raise ConnectorError('reauth_required' if token.get('reauth') else 'not_connected')
        access, expires = _text(token.get('access_token')), token.get('expires_at')
        if (not force and access and isinstance(expires, (int, float)) and not isinstance(expires, bool)
                and expires - time.time() > REFRESH_MARGIN):
            return access
        try:
            body = _token_request(dict(grant_type='refresh_token', refresh_token=refresh, client_id=client[0],
                                       client_secret=client[1]))
        except ConnectorError as error:
            if error.kind != 'invalid_grant':
                raise
            _edit(pipeline, lambda t: (_drop_login(t), t.update(reauth=True)))
            raise ConnectorError('reauth_required') from None

        def renew(t):
            t.update(access_token=body['access_token'], expires_at=time.time() + _lifetime(body))
            if isinstance(body.get('refresh_token'), str) and body['refresh_token']:
                t['refresh_token'] = body['refresh_token']
            t.pop('reauth', None)
        _edit(pipeline, renew)
        return body['access_token']


def _docs_get(pipeline, doc_id, fields=None):
    """The Docs API answer of one document (a dict). One 401 is answered by one refresh and one more try."""
    if not DOC_ID.fullmatch(doc_id or ''):
        raise ConnectorError('bad_scope')
    url = f'{_endpoint("docs")}/documents/{doc_id}' + (f'?{urllib.parse.urlencode(dict(fields=fields))}' if fields else '')
    for attempt in (0, 1):
        status, body = _call('GET', url, bearer=_access_token(pipeline, force=attempt == 1))
        if status == 200:
            return body
        if status != 401 or attempt:
            raise _docs_error(status)


# ---------------------------------------------------------------------------------------------------------------------
# Docs API JSON -> sections

def _dict(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _paragraph(paragraph):
    """(text, named style, list nesting level or None) of one paragraph: its text runs, a soft line break kept as one."""
    runs = [_dict(_dict(element).get('textRun')).get('content') for element in _list(paragraph.get('elements'))]
    text = ''.join(run for run in runs if isinstance(run, str)).replace('\x0b', '\n').strip()
    bullet, level = paragraph.get('bullet'), None
    if isinstance(bullet, dict):
        nesting = bullet.get('nestingLevel')
        level = nesting if type(nesting) is int and nesting > 0 else 0
    return text, _dict(paragraph.get('paragraphStyle')).get('namedStyleType'), level


def _cell_texts(content):
    """The visible paragraphs of a table cell (nested tables flattened), whitespace folded."""
    found = []
    for element in _list(content):
        element = _dict(element)
        if isinstance(element.get('paragraph'), dict):
            text = ' '.join(_paragraph(element['paragraph'])[0].split())
            if text:
                found.append(text)
        elif isinstance(element.get('table'), dict):
            for row in _list(element['table'].get('tableRows')):
                for cell in _list(_dict(row).get('tableCells')):
                    found.extend(_cell_texts(_dict(cell).get('content')))
    return found


def _table_rows(table):
    """One tab-separated line per row that has any text."""
    rows = []
    for row in _list(table.get('tableRows')):
        cells = [' '.join(_cell_texts(_dict(cell).get('content'))) for cell in _list(_dict(row).get('tableCells'))]
        if any(cells):
            rows.append('\t'.join(cells))
    return rows


class _Sections:
    """Builds the sections: a heading (TITLE, HEADING_1..3) closes the one before it; the text before the first heading
    belongs to the document's title. Paragraphs are one blank line apart, list items and table rows one line."""

    def __init__(self, title):
        self.sections, self.heading, self.parts, self.in_list, self.first = [], title, [], False, None

    def seen(self, text):
        if self.first is None:
            self.first = text.split('\n')[0]

    def close(self):
        text = ''.join(self.parts).strip()
        if text:
            self.sections.append(dict(heading=self.heading, text=text, author_is_me=None))
        self.parts, self.in_list = [], False

    def start(self, heading):
        self.seen(heading)
        self.close()
        self.heading = ' '.join(heading.split())

    def add(self, text, is_list=False):
        self.seen(text)
        if self.parts:
            self.parts.append('\n' if is_list and self.in_list else '\n\n')
        self.parts.append(text)
        self.in_list = is_list


def sections_of(body, title=''):
    """([{heading, text, author_is_me: None}], first visible line) of a Docs API document: paragraphs are joined text
    runs, bullets are '- ' (two spaces per nesting level), tables are tab-separated rows; the table of contents, section
    breaks, page breaks and empty paragraphs are skipped."""
    built = _Sections(' '.join(str(title or '').split())[:base.MAX_HEADING])
    for element in _list(_dict(_dict(body).get('body')).get('content')):
        element = _dict(element)
        if isinstance(element.get('paragraph'), dict):
            text, style, level = _paragraph(element['paragraph'])
            if not text:
                continue
            if style in HEADING_STYLES:
                built.start(text)
            elif level is not None:
                built.add('  ' * level + '- ' + text, True)
            else:
                built.add(text)
        elif isinstance(element.get('table'), dict):
            rows = _table_rows(element['table'])
            if rows:
                built.add('\n'.join(rows))
    built.close()
    return built.sections, built.first


# ---------------------------------------------------------------------------------------------------------------------
# The provider

def doc_id_of(text):
    """The document id of a pasted Google Docs address (or of a bare id); ValueError (Korean) for anything else."""
    text = (text or '').strip()
    found = DOC_URL.fullmatch(text)
    if found:
        return found.group(1)
    if BARE_DOC_ID.fullmatch(text):
        return text
    raise ValueError('구글 문서 주소를 확인하세요. 예: https://docs.google.com/document/d/…/edit (시트·슬라이드는 아직 읽지 않습니다)')


class GoogleDocsProvider(base.Provider):
    site = SITE
    label = '구글 문서'

    def status(self, pipeline):
        token = _load(pipeline)
        if not token:
            return dict(connected=False, tokenSet=False, needs='구글 클라이언트 ID와 보안 비밀을 입력하세요.')
        if _logged_in(token):
            return dict(connected=True, tokenSet=True, needs=None)
        if token.get('reauth'):
            needs = '다시 연결하세요 (테스트 앱은 7일마다 만료)'
        elif not _client(token):
            needs = '구글 클라이언트 ID와 보안 비밀을 입력하세요.'
        else:
            needs = '“구글 계정 연결”을 눌러 로그인하세요.'
        return dict(connected=False, tokenSet=True, needs=needs)

    def setup_html(self, pipeline):
        token = _load(pipeline) or {}
        client, logged_in = _client(token), _logged_in(token)
        saved = ' <small>(저장됨 · 바꾸려면 다시 입력)</small>' if client else ''
        html = ('<p class="note">구글 Cloud Console에서 ① Google Docs API 사용 설정 ② OAuth 동의 화면에 본인 계정을 테스트 사용자로 추가 '
                '③ “데스크톱 앱” 종류의 OAuth 클라이언트 만들기를 한 뒤, 그 클라이언트 ID와 보안 비밀을 넣으세요. '
                '둘 다 이 PC에만 저장됩니다. 테스트 상태의 앱은 연결이 7일마다 끝나 다시 연결해야 합니다.</p>'
                f'<label>OAuth 클라이언트 ID{saved}<input name="client_id" autocomplete="off" spellcheck="false" maxlength="200" '
                'placeholder="….apps.googleusercontent.com"></label>'
                f'<label>클라이언트 보안 비밀{saved}<input name="client_secret" type="password" autocomplete="off" '
                'spellcheck="false" maxlength="200"></label>')
        if not logged_in:
            html += '<div class="actions"><button name="action" value="connect">구글 계정 연결</button></div>'
            if token.get('reauth'):
                html += '<p class="note">연결이 끝났습니다(테스트 앱 7일 만료 또는 권한 취소). 다시 연결하세요.</p>'
        link = consent_url(pipeline, token)
        if link:
            html += (f'<p role="status"><a href="{escape(link, quote=True)}" target="_blank" rel="noopener noreferrer">구글 로그인 열기</a> — '
                     '10분 안에 허용하면 이 화면으로 돌아옵니다. “문서 읽기”만 허용하면 됩니다.</p>')
        if logged_in:
            html += ('<label>구글 문서 주소<input name="doc_url" autocomplete="off" spellcheck="false" maxlength="500" '
                     'placeholder="https://docs.google.com/document/d/…/edit"></label>'
                     '<label><input type="checkbox" name="owner" value="1" style="width:auto"> 이 문서의 담당자로서 가져오기</label>'
                     '<p class="note">문서 본문은 쓴 사람을 알 수 없어서, 팀을 대신해 올리는 담당자라고 확인한 문서만 가져옵니다.</p>')
        return html

    def handle_setup(self, pipeline, form):
        client_id, secret = _text(form.get('client_id')).strip(), _text(form.get('client_secret')).strip()
        if client_id and not CLIENT_ID.fullmatch(client_id):
            raise ValueError('클라이언트 ID 형식을 확인하세요 (….apps.googleusercontent.com).')
        if secret and not CLIENT_SECRET.fullmatch(secret):
            raise ValueError('클라이언트 보안 비밀 형식을 확인하세요.')
        saved_client = False
        if client_id or secret:
            def keep(token):
                if client_id:
                    if token.get('client_id') != client_id:
                        _drop_login(token)  # a login belongs to the client that made it
                    token['client_id'] = client_id
                if secret:
                    token['client_secret'] = secret
            token = _edit(pipeline, keep)
            saved_client = True
        else:
            token = _load(pipeline) or {}
        if form.get('action') == 'connect':
            return self._connect(pipeline, token, bool(_text(form.get('doc_url')).strip()))
        if _text(form.get('doc_url')).strip():
            return self._add_document(pipeline, token, saved_client, _text(form['doc_url']), form.get('owner') in ('1', 'on'))
        if saved_client:
            return '클라이언트 정보를 저장했습니다. 이어서 “구글 계정 연결”을 눌러 로그인하세요.'
        raise ValueError('입력한 내용이 없습니다.')

    def _connect(self, pipeline, token, ignored_document):
        if not _client(token):
            raise ValueError('먼저 클라이언트 ID와 보안 비밀을 입력하세요.')
        if not base.local_page_url(pipeline, CALLBACK):
            raise ValueError('이 화면의 주소를 아직 알 수 없습니다. 잠시 뒤 다시 누르세요.')
        verifier = secrets.token_urlsafe(64)
        _edit(pipeline, lambda t: t.update(pending=dict(verifier=verifier, expires_at=time.time() + PENDING_SECONDS)))
        note = ' 문서 주소는 연결을 마친 뒤 다시 넣으세요.' if ignored_document else ''
        return '구글 로그인 링크를 만들었습니다. “구글 로그인 열기”를 눌러 10분 안에 허용하세요.' + note

    def _add_document(self, pipeline, token, saved_client, address, owner):
        prefix = '클라이언트 정보는 저장했습니다. ' if saved_client else ''
        try:
            doc_id = doc_id_of(address)
            if not _logged_in(token):
                raise ValueError('먼저 구글 계정을 연결하세요.')
            try:
                title = _text(_docs_get(pipeline, doc_id, fields='title').get('title')).strip()
            except ConnectorError as error:
                raise ValueError(_explain(error)) from None
        except ValueError as error:
            raise ValueError(prefix + str(error)) from None
        title = title[:base.MAX_TITLE] or doc_id
        base.set_scope(pipeline, SITE, doc_id, title, True)
        _edit(pipeline, lambda t: t['owner'].__setitem__(doc_id, owner))
        if owner:
            return f'문서를 추가했습니다: {title}. 5분마다, 또는 “지금 가져오기”로 읽습니다.'
        return (f'문서를 추가했지만 담당자 확인이 없어 아직 읽지 않습니다: {title}. '
                '같은 주소를 다시 넣고 “이 문서의 담당자로서 가져오기”를 체크하세요.')

    def handle_callback(self, pipeline, query):
        with _LOCK:
            token = _load(pipeline) or {}
            pending = _pending(token)
            if not pending:
                raise ValueError('진행 중인 구글 연결이 없습니다. 이미 연결을 마쳤다면 무시해도 됩니다. '
                                 '처음부터 하려면 “구글 계정 연결”을 누르세요.')
            if pending['expires_at'] <= time.time():
                _edit(pipeline, lambda t: t.pop('pending', None))
                raise ValueError('로그인 시간(10분)이 지났습니다. “구글 계정 연결”을 다시 누르세요.')
            state = _text(query.get('state'))
            if not hmac.compare_digest(state.encode(), _state(pending['verifier']).encode()):
                raise ValueError('이 연결 요청은 내가 시작한 것이 아니어서 거절했습니다. “구글 계정 연결”을 다시 누르세요.')
            _edit(pipeline, lambda t: t.pop('pending', None))  # a login link works once
            code, client = _text(query.get('code')), _client(token)
            if query.get('error') or not code or not client:
                raise ValueError('구글 로그인이 취소되었거나 허용되지 않았습니다. “구글 계정 연결”을 다시 누르세요.')
            redirect = base.local_page_url(pipeline, CALLBACK)
            if not redirect:
                raise ValueError('이 화면의 주소를 알 수 없습니다. 다시 연결하세요.')
            try:
                body = _token_request(dict(grant_type='authorization_code', code=code, redirect_uri=redirect, client_id=client[0],
                                           client_secret=client[1], code_verifier=pending['verifier']))
            except ConnectorError as error:
                raise ValueError(_explain(error)) from None
            granted = body.get('scope')
            if isinstance(granted, str) and SCOPE not in granted.split():
                raise ValueError('문서 읽기 권한이 허용되지 않았습니다. 로그인 화면에서 “문서 보기”를 허용해 다시 연결하세요.')
            if not _text(body.get('refresh_token')):
                raise ValueError('구글이 오래 쓰는 연결 정보를 주지 않았습니다. 구글 계정의 앱 접근에서 이 앱을 지우고 다시 연결하세요.')

            def store(t):
                t.update(refresh_token=body['refresh_token'], access_token=body['access_token'],
                         expires_at=time.time() + _lifetime(body))
                t.pop('reauth', None)
            _edit(pipeline, store)
        return '구글 계정을 연결했습니다. 이제 읽을 구글 문서 주소를 붙여 넣으세요.'

    def fetch(self, pipeline, scope):
        doc_id = scope.get('scope_id')
        if not isinstance(doc_id, str) or not DOC_ID.fullmatch(doc_id):
            raise ConnectorError('bad_scope')
        if _dict((_load(pipeline) or {}).get('owner')).get(doc_id) is not True:
            raise ConnectorError('owner_unconfirmed')  # the author of body text is unknown: only the owner's say counts
        body = _docs_get(pipeline, doc_id)
        title = _text(body.get('title')).strip()
        sections, first = sections_of(body, title)
        revision = _text(body.get('revisionId')) or ('sha256:' + hashlib.sha256(
            json.dumps([title, sections], ensure_ascii=False).encode()).hexdigest()[:40])  # read-only users get no revisionId
        if scope.get('cursor') == revision:
            return [], None
        if not sections or (first or '').startswith(TEAM_RECORD_HEAD):  # nothing to read, or SyncUp's own board pasted back
            return [], revision
        document = dict(source_id=doc_id, title=title, url=f'https://docs.google.com/document/d/{doc_id}/edit',
                        modified=datetime.now(timezone.utc), sections=sections)
        return [document], revision

    def disconnect(self, pipeline):
        """Revoke the grant at Google (a failure is ignored: the file goes either way), then delete the file."""
        try:
            token = _load(pipeline) or {}
            refresh = _text(token.get('refresh_token')) or _text(token.get('access_token'))
            if refresh:
                _call('POST', _endpoint('revoke'), form=dict(token=refresh), timeout=REVOKE_TIMEOUT)
        except (ConnectorError, ValueError, OSError):
            pass
        base.delete_token(base.state_dir(pipeline), SITE)


base.register(GoogleDocsProvider())
