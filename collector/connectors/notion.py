"""The Notion connector: reads the pages a user chose with an internal integration token (docs/connectors.md).

    setup      the token (password input), root page addresses, "my Notion user", "I own undated blocks" (checkbox)
    fetch      GET /v1/pages/{id}, GET /v1/blocks/{id}/children (every page, nested blocks too), child pages as documents of
               their own, child databases as one section per row (POST /v1/databases/{id}/query)
    authors    each block says who edited it last; a section never mixes authors (base.py skips the ones that are not mine)

The token and the settings live in one file, base.load_token/save_token(state_dir, 'notion'): {token, owner, user_id}.
Everything base.scrub finds in that file (any string of 8+ characters) is blanked in the page and the status, so the setup
form shows people by their id without dashes (the file keeps the dashed one) and never prints the token.
No error carries a response body, a URL or the token: ConnectorError(kind, status) only. Requests go to SYNCUP_NOTION_API
(default https://api.notion.com), never follow a redirect, and are spaced to Notion's average rate (docs: request-limits).
Standard library only. Limits and fields: developers.notion.com reference (Notion-Version 2022-06-28).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import html
import http.client
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from connectors import base

SITE = 'notion'
DEFAULT_API = 'https://api.notion.com'
API_ENV = 'SYNCUP_NOTION_API'
NOTION_VERSION = '2022-06-28'
REQUEST_INTERVAL = 1 / 3  # 180 requests a minute per integration outside Business and Enterprise plans
TIMEOUT = 20
SETUP_TIMEOUT = 8  # the setup form asks Notion while a page is being drawn: do not hold it for long
RATE_RETRIES = 4  # 429: wait Retry-After, then again, this many times
SERVER_RETRIES = 2  # 500/502/503/504: every call here only reads, so again after 1 s, then 2 s
LONGEST_RETRY_AFTER = 60  # a longer wait fails this run; the next run tries again
MAX_RESPONSE = 16 * 1024 * 1024
MAX_DEPTH = 3  # child pages below the root page that are read
MAX_PAGES = 50  # pages and databases read in one run
MAX_REQUESTS = 600  # about 200 seconds at the pace above
MAX_BLOCK_DEPTH = 10  # nested blocks (toggle in toggle ...)
MAX_ROWS = 500  # rows of one database
MAX_SETUP_PAGES = 20
MAX_USER_PAGES = 5  # pages of 100 people in the "my Notion user" list
SETTLE = timedelta(seconds=120)  # last_edited_time is rounded to the minute: a page edited a moment ago is read again
RECORD_TITLES = ('싱크업 팀 기록', 'syncup 팀 기록')  # the team record SyncUp writes to Notion (server/notion_page.py)
LOOPBACK = ('127.0.0.1', 'localhost', '::1')
ON = ('1', 'on', 'true')
UNTITLED = '제목 없음'

# Tests replace these two (a clock they can move without waiting); the defaults are the real ones.
_clock = time.monotonic
_sleep = time.sleep
_turns = threading.Lock()  # one integration token, so one request pace for every caller
_next_turn = 0.0  # _clock() time the next request may start


def _now():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------------------------------------------------
# Page addresses and ids

_UUID = re.compile(r'[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}')
_HEX32 = re.compile(r'(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])')
_DASHED = re.compile(r'(?<![0-9a-fA-F])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])')
_TOKEN = re.compile(r'[A-Za-z0-9_.~+/=-]{10,300}')


def _digits(value):
    """The 32 lower-case hex digits of a Notion id (dashed or not), or None."""
    if isinstance(value, str) and _UUID.fullmatch(value):
        return value.replace('-', '').lower()
    return None


def _dashed(digits):
    return f'{digits[:8]}-{digits[8:12]}-{digits[12:16]}-{digits[16:20]}-{digits[20:]}'


def _last_id(text):
    """The last id (32 hex digits, or dashed) inside text, as digits; None when there is none."""
    found = [m.group(0) for m in _DASHED.finditer(text)] + [m.group(0) for m in _HEX32.finditer(text)]
    if not found:
        return None
    last = max(found, key=lambda value: text.rfind(value))
    return _digits(last)


def parse_page_id(text):
    """The id of a Notion page as a dashed lower-case UUID, from a notion.so / *.notion.site address or a bare id.
    ValueError (Korean) for anything else. Only the id is used: the address itself is never requested."""
    value = text.strip() if isinstance(text, str) else ''
    if not value:
        raise ValueError('페이지 주소나 id를 입력하세요.')
    if _UUID.fullmatch(value):
        return _dashed(_digits(value))
    try:
        parts = urllib.parse.urlsplit(value if '://' in value else 'https://' + value)
        host = (parts.hostname or '').lower()
        query = urllib.parse.parse_qs(parts.query)
    except ValueError:
        raise ValueError('노션 페이지 주소를 확인하세요.') from None
    if not (host in ('notion.so', 'www.notion.so') or host.endswith(('.notion.so', '.notion.site'))):
        raise ValueError('노션 페이지 주소(notion.so)나 페이지 id를 입력하세요.')
    digits = None
    for peeked in query.get('p', []):  # a page opened beside its database: ?p=<page id>
        digits = digits or _last_id(peeked)
    segments = [s for s in urllib.parse.unquote(parts.path).split('/') if s]
    digits = digits or (_last_id(segments[-1]) if segments else None)
    if digits is None:
        raise ValueError('주소에서 페이지 id를 찾지 못했습니다. 페이지의 링크 복사로 얻은 주소를 쓰세요.')
    return _dashed(digits)


def parse_pages(text):
    """The distinct page ids (dashed) of a box with one address or id per line (commas and spaces also separate)."""
    found = []
    for piece in re.split(r'[\s,]+', text.strip() if isinstance(text, str) else ''):
        if piece:
            page_id = parse_page_id(piece)
            if page_id not in found:
                found.append(page_id)
    if len(found) > MAX_SETUP_PAGES:
        raise ValueError(f'한 번에 페이지 {MAX_SETUP_PAGES}개까지 추가할 수 있습니다.')
    return found


def _time(value):
    """An aware datetime from a Notion time ('2026-11-14T12:30:00.000Z'), or None."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _iso(moment):
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------------------------------------------------------------
# HTTP

class _Budget(Exception):
    """This run asked Notion MAX_REQUESTS times: stop reading (never leaves this module)."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the 3xx comes back as an HTTPError: the token is never sent to another address


_REMOTE = urllib.request.build_opener(_NoRedirect)
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)  # a test server is not behind the proxy
_KINDS = {400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limit'}


def _api_base():
    """(base address, is it this machine) from SYNCUP_NOTION_API. ConnectorError for an address the token must not go to."""
    raw = (os.environ.get(API_ENV) or DEFAULT_API).strip().rstrip('/')
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or '').lower()
        port = parts.port  # noqa: F841  raises ValueError for a bad port
    except ValueError:
        raise base.ConnectorError('config') from None
    if parts.scheme not in ('http', 'https') or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise base.ConnectorError('config')
    local = host in LOOPBACK
    if parts.scheme == 'http' and not local:
        raise base.ConnectorError('insecure_api')  # the token would cross the network in the clear
    return raw, local


def _take_turn():
    """Wait until the request pace allows the next request, and book the one after it."""
    global _next_turn
    with _turns:
        now = _clock()
        start = max(now, _next_turn)
        _next_turn = start + REQUEST_INTERVAL
    if start > now:
        _sleep(start - now)


def _hold(seconds):
    """Rate limited: no request of anyone starts before `seconds` from now."""
    global _next_turn
    with _turns:
        _next_turn = max(_next_turn, _clock() + seconds)


class _Api:
    """GET and POST of one integration token: paced, retried as Notion asks, JSON objects out, ConnectorError for the rest."""

    def __init__(self, token, timeout=TIMEOUT, rate_retries=RATE_RETRIES, limit=None):
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            raise base.ConnectorError('unauthorized')  # also keeps a line break out of the header
        self.token, self.timeout, self.rate_retries, self.limit, self.calls = token, timeout, rate_retries, limit, 0
        self.base, local = _api_base()
        self.opener = _LOCAL if local else _REMOTE

    def get(self, path, **query):
        query = {k: v for k, v in query.items() if v is not None}
        return self._call('GET', path + ('?' + urllib.parse.urlencode(query) if query else ''), None)

    def post(self, path, body):
        return self._call('POST', path, body)

    def _call(self, method, path, body):
        url = f'{self.base}/v1/{path}'
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        tries = dict(rate=0, server=0)
        while True:
            self.calls += 1
            if self.limit is not None and self.calls > self.limit:
                raise _Budget
            _take_turn()
            request = urllib.request.Request(url, data=data, method=method, headers={
                'Notion-Version': NOTION_VERSION, 'Accept': 'application/json', 'User-Agent': 'SyncUp-collector',
                **({'Content-Type': 'application/json'} if data is not None else {})})
            request.add_unredirected_header('Authorization', 'Bearer ' + self.token)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    raw = response.read(MAX_RESPONSE + 1)
            except urllib.error.HTTPError as error:
                status = error.code
                retry_after = error.headers.get('Retry-After') if error.headers else None
                error.close()
                wait = self._wait(status, retry_after, tries)
                if wait is None:
                    raise base.ConnectorError(_KINDS.get(status) or ('server_error' if status >= 500 else 'http_error'),
                                              status) from None
                _hold(wait)
                continue
            except (OSError, http.client.HTTPException):  # no connection, a timeout, a broken answer
                raise base.ConnectorError('network') from None
            except ValueError:  # an address urllib refuses; the text may hold the address, so none of it is kept
                raise base.ConnectorError('bad_request') from None
            if len(raw) > MAX_RESPONSE:
                raise base.ConnectorError('too_large')
            try:
                result = json.loads(raw)
            except ValueError:
                raise base.ConnectorError('bad_response') from None
            if not isinstance(result, dict):
                raise base.ConnectorError('bad_response')
            return result

    def _wait(self, status, retry_after, tries):
        """Seconds to wait before the same request again, or None when it is not worth another try."""
        if status == 429:
            if tries['rate'] >= self.rate_retries:
                return None
            try:
                seconds = float(retry_after) if retry_after is not None else 1.0
            except ValueError:
                seconds = 1.0
            if not 0 <= seconds <= LONGEST_RETRY_AFTER:  # also NaN
                return None
            tries['rate'] += 1
            return seconds
        if status in (500, 502, 503, 504) and tries['server'] < SERVER_RETRIES:
            tries['server'] += 1
            return float(tries['server'])
        return None


# ---------------------------------------------------------------------------------------------------------------------
# Blocks and properties as text

HEADINGS = {'heading_1': '# ', 'heading_2': '## ', 'heading_3': '### '}
INDENTED = frozenset({'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle'})  # their children are indented
SKIPPED = frozenset({'divider', 'child_page', 'child_database', 'table', 'column_list', 'column', 'synced_block', 'bookmark',
                     'embed', 'link_preview', 'image', 'video', 'file', 'pdf', 'audio', 'link_to_page', 'template',
                     'table_of_contents', 'breadcrumb', 'unsupported'})  # no text of their own (containers are still entered)


def _plain(rich):
    """The plain text of a rich_text array."""
    if not isinstance(rich, list):
        return ''
    return ''.join(item.get('plain_text') or '' for item in rich if isinstance(item, dict) and isinstance(item.get('plain_text', ''), str))


def _title(properties):
    """The title of a page (its title-type property) as one line."""
    if isinstance(properties, dict):
        for prop in properties.values():
            if isinstance(prop, dict) and prop.get('type') == 'title':
                return ' '.join(_plain(prop.get('title')).split())
    return ''


def _is_record(text):
    """Is this the team record SyncUp writes to Notion (its title or its first line, with or without a leading #)?"""
    start = text.lstrip('#').strip().lower() if isinstance(text, str) else ''
    return any(start.startswith(title) for title in RECORD_TITLES)


def _line(kind, body, number):
    """(text, is_heading) of one block, or None when it has no text of its own."""
    if kind in SKIPPED or not isinstance(body, dict):
        return None
    if kind == 'table_row':
        cells = body.get('cells')
        text = '\t'.join(' '.join(_plain(cell).split()) for cell in cells) if isinstance(cells, list) else ''
        return (text, False) if text.strip('\t ') else None
    if kind == 'equation':
        text = body.get('expression') if isinstance(body.get('expression'), str) else ''
        return (text, False) if text.strip() else None
    text = _plain(body.get('rich_text'))
    if not text.strip():
        return None
    if kind in HEADINGS:
        return HEADINGS[kind] + ' '.join(text.split()), True
    if kind == 'bulleted_list_item':
        text = '- ' + text
    elif kind == 'numbered_list_item':
        text = f'{number}. {text}'
    elif kind == 'to_do':
        text = ('[x] ' if body.get('checked') is True else '[ ] ') + text
    elif kind == 'quote':
        text = '> ' + text
    elif kind == 'code':
        language = body.get('language') if isinstance(body.get('language'), str) else ''
        text = f'```{"" if language == "plain text" else language}\n{text.strip(chr(10))}\n```'
    return text, False  # paragraph, toggle, callout and any other block that has rich_text


def _indent(text, level):
    return '\n'.join('  ' * level + line for line in text.split('\n')) if level else text


def _sections(units):
    """[{heading, text, author_is_me}] of [(author, is_heading, text)]: a heading starts a section, and so does a change
    of author, so no section mixes authors. A section without text (a heading alone) is dropped."""
    sections, current = [], None
    for author, heading, text in units:
        if heading:
            current = dict(heading=text, lines=[], author=author)
            sections.append(current)
        elif current is None or current['author'] is not author:
            current = dict(heading='', lines=[text], author=author)
            sections.append(current)
        else:
            current['lines'].append(text)
    return [dict(heading=s['heading'], text='\n'.join(s['lines']), author_is_me=s['author']) for s in sections if s['lines']]


def _value(prop):
    """One database property as text ('' for the kinds with nothing to say: relations, files, rollups, timestamps ...)."""
    if not isinstance(prop, dict):
        return ''
    kind = prop.get('type')
    value = prop.get(kind) if isinstance(kind, str) else None
    if kind in ('title', 'rich_text'):
        return ' '.join(_plain(value).split())
    if kind in ('select', 'status'):
        return str(value.get('name') or '') if isinstance(value, dict) else ''
    if kind == 'multi_select':
        return ', '.join(str(o.get('name')) for o in value if isinstance(o, dict) and o.get('name')) if isinstance(value, list) else ''
    if kind == 'number':
        return '' if type(value) not in (int, float) else (str(int(value)) if float(value).is_integer() else str(value))
    if kind == 'checkbox':
        return '예' if value is True else '아니오'
    if kind == 'date':
        if not isinstance(value, dict) or not value.get('start'):
            return ''
        return str(value['start']) + (f' → {value["end"]}' if value.get('end') else '')
    if kind == 'people':
        return ', '.join(str(p.get('name')) for p in value if isinstance(p, dict) and p.get('name')) if isinstance(value, list) else ''
    if kind in ('url', 'email', 'phone_number'):
        return value if isinstance(value, str) else ''
    if kind == 'formula' and isinstance(value, dict):  # {type: 'string'|'number'|'boolean'|'date', <type>: value}
        inner = value.get('type')
        if inner == 'string':
            return value['string'] if isinstance(value.get('string'), str) else ''
        if inner == 'boolean':
            return '예' if value.get('boolean') is True else '아니오'
        return _value({'type': inner, inner: value.get(inner)}) if inner in ('number', 'date') else ''
    return ''


def _row_text(row):
    """The '속성: 값' lines of one database row (a page object)."""
    properties = row.get('properties')
    lines = []
    if isinstance(properties, dict):
        for name, prop in properties.items():
            text = _value(prop)
            if text.strip():
                lines.append(f'{name}: {text}')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------------------------------------------------
# One run: the pages under one root page

class _Run:
    """Reads the pages under a root page into documents. `me`: my Notion user id as 32 hex digits, or None (then every
    block is of unknown author, which fetch only allows when the user said they own the pages). `cursor`: pages not
    edited after it are walked (their child pages may have changed) but make no document."""

    def __init__(self, api, me, cursor):
        self.api, self.me, self.cursor = api, me, cursor
        self.documents, self.newest, self.visited, self.truncated = [], None, 0, False

    def author(self, item):
        """True when the block (or row) was last edited by me, False when by somebody else, None when I have no id."""
        if self.me is None:
            return None
        for key in ('last_edited_by', 'created_by'):
            user = item.get(key)
            if isinstance(user, dict) and user.get('id'):
                return _digits(user['id']) == self.me
        return False  # nobody named: not provably mine

    def seen(self, moment):
        if moment is not None and (self.newest is None or moment > self.newest):
            self.newest = moment

    def changed(self, moment):
        return self.cursor is None or moment is None or moment > self.cursor

    def read(self, root):
        """(documents, new cursor or None)."""
        queue, done = [('page', root, 0, None)], set()
        while queue:
            kind, item_id, depth, hint = queue.pop(0)
            if item_id in done:
                continue
            done.add(item_id)
            if self.visited >= MAX_PAGES:
                self.truncated = True
                break
            self.visited += 1
            try:
                found = self.page(item_id, depth, hint) if kind == 'page' else self.database(item_id, hint)
            except _Budget:
                self.truncated = True
                break
            except base.ConnectorError as error:
                if depth > 0 and error.kind in ('not_found', 'forbidden', 'bad_request'):  # one page or database Notion will
                    continue  # not show (a linked database, one nobody shared) must not stop the rest; the root and a bad token still do
                raise
            for child in found:
                if child[2] <= MAX_DEPTH:
                    queue.append(child)
                else:
                    self.truncated = True
        return self.documents, self.next_cursor()

    def next_cursor(self):
        """The newest edit seen, kept a little behind now (Notion's times are whole minutes); None while anything was not read."""
        if self.newest is None or self.truncated:
            return None
        held = min(self.newest, _now() - SETTLE)
        return None if self.cursor is not None and held <= self.cursor else _iso(held)

    def page(self, page_id, depth, hint):
        """Read one page: its document when it changed. Returns the child pages and databases found, to read next."""
        if _is_record(hint):
            return []
        page = self.api.get(f'pages/{page_id}')
        if page.get('archived') is True or page.get('in_trash') is True:
            return []
        title = _title(page.get('properties')) or (hint or '')
        edited = _time(page.get('last_edited_time'))
        if edited is None:
            raise base.ConnectorError('bad_response')
        self.seen(edited)
        if _is_record(title):
            return []
        units, found = [], []
        self.blocks(page_id, 0, 0, units, found, depth)
        first = next((text for _, _, text in units if text.strip()), '')
        if _is_record(first):
            return []
        sections = _sections(units) if self.changed(edited) else []
        if sections:
            document = dict(source_id=_dashed(_digits(page_id)), title=title or UNTITLED, modified=edited, sections=sections)
            if isinstance(page.get('url'), str) and len(page['url']) <= 500:
                document['url'] = page['url']
            self.documents.append(document)
        return found

    def blocks(self, parent_id, level, indent, units, found, depth):
        """Append (author, is_heading, text) of the blocks under parent_id, and ('page'|'database', id, depth, title) of the
        child pages and databases, to the two lists."""
        number = 0
        for block in self.children(parent_id):
            if not isinstance(block, dict) or block.get('archived') is True or block.get('in_trash') is True:
                continue
            kind = block.get('type')
            body = block.get(kind) if isinstance(kind, str) else None
            block_id = block.get('id')
            number = number + 1 if kind == 'numbered_list_item' else 0
            if kind in ('child_page', 'child_database'):
                title = body.get('title') if isinstance(body, dict) and isinstance(body.get('title'), str) else ''
                if _digits(block_id):
                    found.append(('page' if kind == 'child_page' else 'database', block_id, depth + 1, title))
                continue
            line = _line(kind, body, number)
            if line:
                units.append((self.author(block), line[1], line[0] if line[1] else _indent(line[0], indent)))
            nested = block.get('has_children') is True and _digits(block_id) and not (
                kind == 'synced_block' and isinstance(body, dict) and body.get('synced_from'))  # a copy shows the original's blocks
            if nested:
                if level < MAX_BLOCK_DEPTH:
                    self.blocks(block_id, level + 1, indent + (1 if kind in INDENTED else 0), units, found, depth)
                else:
                    self.truncated = True

    def children(self, block_id):
        start = None
        while True:
            answer = self.api.get(f'blocks/{block_id}/children', page_size=100, start_cursor=start)
            results = answer.get('results')
            yield from results if isinstance(results, list) else []
            start = answer.get('next_cursor')
            if not (answer.get('has_more') is True and isinstance(start, str) and start):
                return

    def database(self, database_id, hint):
        """One document with a section per row changed since the cursor: 속성: 값 lines. Returns no child pages."""
        rows, start = [], None
        while True:
            body = dict(page_size=100)
            if start:
                body['start_cursor'] = start
            if self.cursor is not None:
                body['filter'] = dict(timestamp='last_edited_time', last_edited_time=dict(after=_iso(self.cursor)))
            answer = self.api.post(f'databases/{database_id}/query', body)
            results = answer.get('results')
            rows += [r for r in results if isinstance(r, dict) and r.get('archived') is not True and r.get('in_trash') is not True] \
                if isinstance(results, list) else []
            start = answer.get('next_cursor')
            if not (answer.get('has_more') is True and isinstance(start, str) and start):
                break
            if len(rows) >= MAX_ROWS:
                self.truncated = True
                break
        sections, newest = [], None
        for row in rows[:MAX_ROWS]:
            edited = _time(row.get('last_edited_time'))
            self.seen(edited)
            if edited is None or not self.changed(edited):
                continue
            newest = edited if newest is None or edited > newest else newest
            text = _row_text(row)
            if text.strip():
                sections.append(dict(heading=hint or '', text=text, author_is_me=self.author(row)))
        if sections:
            self.documents.append(dict(source_id=_dashed(_digits(database_id)), title=hint or UNTITLED, modified=newest,
                                       sections=sections))
        return []


# ---------------------------------------------------------------------------------------------------------------------
# The provider

PROBLEMS = {
    'unauthorized': '노션이 이 토큰을 받아들이지 않습니다. 내부 통합의 토큰을 다시 복사해 넣으세요.',
    'forbidden': '이 통합에는 읽기 권한이 없습니다. 노션 통합 설정에서 "콘텐츠 읽기"를 켜세요.',
    'not_found': '노션에서 찾을 수 없습니다. 그 페이지를 통합에 공유했는지 확인하세요(페이지 ⋯ 메뉴 > 연결).',
    'rate_limit': '노션이 요청을 잠시 제한하고 있습니다. 조금 뒤에 다시 시도하세요.',
    'network': '노션에 연결하지 못했습니다. 인터넷 연결을 확인하세요.',
    'bad_request': '노션이 이 요청을 받아들이지 않습니다. 페이지가 아닌 것(데이터베이스 등)은 추가할 수 없습니다.',
}
NEEDS_TOKEN = '노션 통합 토큰을 입력하세요. (노션에서 통합 자체를 없애려면 노션 설정 > 연결에서 지우세요.)'
NEEDS_TOKEN_AGAIN = '노션이 토큰을 받아들이지 않습니다. 새 토큰을 입력하세요.'
NEEDS_USER = '내 노션 사용자를 고르거나, 작성자를 알 수 없는 블록도 문서 담당자로서 가져오기를 켜세요.'
NEEDS_SHARE = '통합에 페이지를 공유하세요: 노션 페이지의 ⋯ 메뉴 > 연결에서 이 통합을 추가하세요.'
NEEDS_PAGE = '통합에 페이지를 공유하세요. 그런 다음 읽을 페이지 주소를 추가하세요.'


def _explain(error):
    return PROBLEMS.get(error.kind) or f'노션 요청에 실패했습니다 ({base.error_kind(error)}).'


def _short(text, limit=40):
    text = ' '.join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


class NotionProvider(base.Provider):
    site = SITE
    label = '노션'

    def _settings(self, pipeline):
        data = base.load_token(base.state_dir(pipeline), SITE)
        return data if data and isinstance(data.get('token'), str) and data['token'] else None

    def status(self, pipeline):
        settings = self._settings(pipeline)
        if not settings:
            return dict(connected=False, tokenSet=False, needs=NEEDS_TOKEN)
        scopes = base.list_scopes(pipeline, SITE)
        errors = [str(s['last_error'] or '') for s in scopes]
        if any(e.startswith('unauthorized') for e in errors):
            needs = NEEDS_TOKEN_AGAIN
        elif not _digits(settings.get('user_id')) and settings.get('owner') is not True:
            needs = NEEDS_USER
        elif any(e.startswith(('not_found', 'forbidden')) for e in errors):
            needs = NEEDS_SHARE
        elif not scopes:
            needs = NEEDS_PAGE
        else:
            needs = None
        return dict(connected=True, tokenSet=True, needs=needs)

    # -- setup form ------------------------------------------------------------------------------------------------

    def _people(self, token):
        """[(id digits, label)] of the people of the workspace (bots left out), or None when Notion cannot be asked now."""
        people, start = [], None
        try:
            api = _Api(token, timeout=SETUP_TIMEOUT, rate_retries=0)
            for _ in range(MAX_USER_PAGES):
                answer = api.get('users', page_size=100, start_cursor=start)
                for user in answer.get('results') if isinstance(answer.get('results'), list) else []:
                    if isinstance(user, dict) and user.get('type') == 'person' and _digits(user.get('id')):
                        email = (user.get('person') or {}).get('email') if isinstance(user.get('person'), dict) else None
                        name = ' '.join(str(user.get('name') or '').split()) or '(이름 없음)'
                        people.append((_digits(user['id']), f'{name} ({email})' if isinstance(email, str) and email else name))
                start = answer.get('next_cursor')
                if not (answer.get('has_more') is True and isinstance(start, str) and start):
                    break
        except Exception:  # the form must still be drawn: without the list the user can type the token and addresses
            return None
        return people

    def setup_html(self, pipeline):
        try:
            settings = self._settings(pipeline)
        except (ValueError, OSError):
            settings = None
        saved = settings is not None
        esc = html.escape
        parts = ['<p class="note">노션 내부 통합(워크스페이스 소유자만 만들 수 있습니다)의 토큰을 넣고, 읽을 페이지를 그 통합에 공유하세요. '
                 '통합에 공유한 페이지만 읽고, 그 아래 페이지도 함께 읽습니다. 토큰은 이 PC에만 저장합니다.</p>',
                 f'<label>통합 토큰{" (저장되어 있습니다. 바꿀 때만 다시 입력)" if saved else ""}'
                 '<input name="token" type="password" autocomplete="off" spellcheck="false" maxlength="300"></label>',
                 '<label>읽을 루트 페이지 주소 또는 id (한 줄에 하나, 하위 페이지는 알아서 읽습니다)'
                 '<textarea name="pages" rows="3" maxlength="4000" placeholder="https://www.notion.so/…"></textarea></label>']
        people = self._people(settings['token']) if saved else None
        if people is not None:
            mine = _digits(settings.get('user_id'))
            people = people + ([(mine, '저장된 사용자')] if mine and mine not in [p[0] for p in people] else [])
            options = '<option value="">고르지 않음</option>' + ''.join(
                f'<option value="{person}"{" selected" if person == mine else ""}>{esc(label)}</option>' for person, label in people)
            parts.append(f'<input type="hidden" name="users_shown" value="1"><label>내 노션 사용자 (내가 쓴 블록만 가져옵니다)'
                         f'<select name="user_id">{options}</select></label>')
        owner = ' checked' if settings and settings.get('owner') is True else ''
        parts.append(f'<label><input type="checkbox" name="owner" value="1" style="width:auto;margin-right:8px"{owner}>'
                     '작성자를 알 수 없는 블록도 문서 담당자로서 가져오기</label>')
        return ''.join(parts)

    def handle_setup(self, pipeline, form):
        settings = self._settings(pipeline) or {}
        pages = parse_pages(form.get('pages') or '')  # a bad address stops everything before anything is saved
        token = (form.get('token') or '').strip()
        if token:
            if not _TOKEN.fullmatch(token):
                raise ValueError('토큰 모양을 확인하세요. 노션 통합 설정의 "내부 통합 토큰"을 그대로 복사해 넣으세요.')
            try:
                _Api(token, timeout=SETUP_TIMEOUT, rate_retries=1).get('users/me')
            except base.ConnectorError as error:
                raise ValueError(_explain(error)) from None
        else:
            token = settings.get('token')
            if not token:
                raise ValueError('통합 토큰을 입력하세요.')
        data = dict(token=token, owner=form.get('owner') in ON)
        mine = _digits(settings.get('user_id'))
        if form.get('users_shown') == '1':  # the select was on the form: what it says is the choice, "고르지 않음" too
            chosen = form.get('user_id')
            mine = _digits(chosen) if chosen else None
            if chosen and mine is None:
                raise ValueError('내 노션 사용자를 목록에서 다시 고르세요.')
        if mine:
            data['user_id'] = _dashed(mine)
        base.save_token(base.state_dir(pipeline), SITE, data)
        added, problems = [], []
        for page_id in pages:
            try:
                page = _Api(token, timeout=SETUP_TIMEOUT, rate_retries=1).get(f'pages/{page_id}')
                title = _title(page.get('properties'))
                if page.get('archived') is True or page.get('in_trash') is True:
                    problems.append(f'{page_id}: 휴지통에 있는 페이지입니다.')
                elif _is_record(title):
                    problems.append(f'{page_id}: 싱크업이 쓴 팀 기록 페이지는 읽지 않습니다.')
                else:
                    base.set_scope(pipeline, SITE, page_id, _short(title or UNTITLED, 200), True)
                    added.append(_short(title or UNTITLED))
            except base.ConnectorError as error:
                problems.append(f'{page_id}: {_explain(error)}')
        message = '노션 연결 정보를 저장했습니다.'
        if added:
            message += f' 읽을 페이지 {len(added)}개를 추가했습니다: {", ".join(added)}.'
        if not mine and data['owner'] is not True:
            message += ' ' + NEEDS_USER
        if problems:
            raise ValueError(message + ' 추가하지 못한 페이지: ' + ' / '.join(problems))
        return message

    # -- reading -----------------------------------------------------------------------------------------------------

    def fetch(self, pipeline, scope):
        settings = self._settings(pipeline)
        if not settings:
            raise base.ConnectorError('unauthorized')
        mine = _digits(settings.get('user_id'))
        if mine is None and settings.get('owner') is not True:
            raise base.ConnectorError('author_unset')  # nobody to tell mine from theirs: nothing is read
        try:
            root = parse_page_id(scope.get('scope_id'))
        except ValueError:
            raise base.ConnectorError('bad_scope') from None
        cursor = _time(scope.get('cursor'))
        return _Run(_Api(settings['token'], limit=MAX_REQUESTS), mine, cursor).read(root)

    def disconnect(self, pipeline):
        base.delete_token(base.state_dir(pipeline), SITE)  # Notion has no call to revoke an internal token


base.register(NotionProvider())
