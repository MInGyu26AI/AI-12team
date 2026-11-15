"""Notion connector (collector/connectors/notion.py) against a fake Notion on 127.0.0.1. No real network, no real token.

The fake keeps pages, blocks, databases and people in memory, answers like the API (Bearer check, start_cursor paging, 404
for what the integration was not given, scripted 429/5xx/redirects) and puts the presented token into every error body, so
any code that copied a response body into an error, a status or a log would leak the canary token these checks look for.
Covers: page address parsing, setup (token check, pages, people select, owner checkbox, status), block conversion, the
speaker rule (mine / others / unknown owner / unset), SyncUp's own team record skipped, the cursor, request pace and
Retry-After, HTTP errors, no redirects, and base.run_scope end to end into turn_intake.
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
from contextlib import contextmanager
from datetime import datetime, timezone
import http.server
import json
import os
import re
import socket
import stat
import sys
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse

from collection_settings import configure
from connectors import base, notion
from local_fixtures import PipelineFixture, get_page, post, server
from local_rpc import dispatch
from review_page import Review
from storage import connect

UTC = timezone.utc
TOKEN = 'ntn_CanaryTokenValue0123456789AbCdEf'  # synthetic: it must be found nowhere but its own file
REVOKED = 'ntn_ARevokedTokenValue0123456789'
ME = '11111111-1111-4111-8111-111111111111'  # my Notion user
OTHER = '22222222-2222-4222-8222-222222222222'
BOT = '33333333-3333-4333-8333-333333333333'
EDIT = '2026-11-10T09:00:00.000Z'
NOW = datetime(2026, 11, 15, 0, 0, tzinfo=UTC)  # the clock of the connector: long after every edit below
REAL_SLEEP, REAL_CLOCK, REAL_API = notion._sleep, notion._clock, notion.DEFAULT_API  # before any check replaces them


def at(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


def rich(text):
    return [dict(type='text', plain_text=text, text=dict(content=text), annotations={})] if text else []


def user(user_id):
    return dict(object='user', id=user_id)


def person(user_id, name, email=None):
    return dict(object='user', id=user_id, type='person', name=name, person=dict(email=email) if email else {})


def prop(kind, value):
    return dict(id=kind, type=kind, **{kind: value})


class FakeNotion:
    """The Notion API as far as the connector uses it. `requests` records every call; `script` makes chosen ones fail."""

    def __init__(self):
        self.token = TOKEN
        self.users = [person(ME, '나', 'me@example.invalid'), person(OTHER, '남'), dict(object='user', id=BOT, type='bot', name='통합', bot={})]
        self.pages, self.blocks, self.index, self.rows = {}, {}, {}, {}
        self.requests, self.script = [], []
        self.per_page, self.ignore_filter, self.counter = 100, False, 0

    # -- building the workspace --------------------------------------------------------------------------------------

    def new_id(self):
        self.counter += 1
        return f'{self.counter:08x}-0000-4000-8000-{self.counter:012x}'

    def add_page(self, title, edited=EDIT, by=ME, page_id=None):
        page_id = page_id or self.new_id()
        self.pages[page_id] = dict(object='page', id=page_id, url='https://www.notion.so/' + page_id.replace('-', ''), archived=False,
                                   in_trash=False, created_time=edited, last_edited_time=edited, created_by=user(by),
                                   last_edited_by=user(by), properties=dict(title=dict(id='title', type='title', title=rich(title))))
        return page_id

    def _put(self, parent, block_id, kind, body, by, edited):
        block = {'object': 'block', 'id': block_id, 'type': kind, 'has_children': False, 'archived': False, 'in_trash': False,
                 'created_time': edited, 'last_edited_time': edited, 'created_by': user(by), 'last_edited_by': user(by), kind: body}
        self.blocks.setdefault(parent, []).append(block)
        self.index[block_id] = block
        if parent in self.index:
            self.index[parent]['has_children'] = True
        return block_id

    def add_block(self, parent, kind, text=None, by=ME, edited=EDIT, **body):
        if text is not None:
            body['rich_text'] = rich(text)
        return self._put(parent, self.new_id(), kind, body, by, edited)

    def child_page(self, parent, title, edited=EDIT, by=ME):
        page_id = self.add_page(title, edited, by)
        self._put(parent, page_id, 'child_page', dict(title=title), by, edited)
        return page_id

    def child_database(self, parent, title):
        database_id = self.new_id()
        self._put(parent, database_id, 'child_database', dict(title=title), ME, EDIT)
        self.rows[database_id] = []
        return database_id

    def table(self, parent, rows, by=ME):
        table_id = self.add_block(parent, 'table', by=by, table_width=len(rows[0]), has_column_header=True, has_row_header=False)
        for row in rows:
            self.add_block(table_id, 'table_row', by=by, cells=[rich(cell) for cell in row])
        return table_id

    def add_row(self, database_id, properties, by=ME, edited=EDIT):
        row = self.add_page('', edited, by)
        self.pages[row]['properties'] = properties
        self.rows[database_id].append(self.pages.pop(row))
        return row

    def fail(self, path, status, times=1, method=None, **headers):
        """The next `times` requests whose path contains `path` answer `status` (None: every one)."""
        self.script.append(dict(path=path, status=status, times=times, method=method, headers=headers))

    def seen(self, *fragments):
        return [r for r in self.requests if all(f in r['path'] for f in fragments)]

    # -- answering ---------------------------------------------------------------------------------------------------

    def answer(self, method, path, query, body, auth):
        for entry in self.script:
            if entry['path'] in path and entry['method'] in (None, method):
                if entry['times'] is not None:
                    entry['times'] -= 1
                    if entry['times'] <= 0:
                        self.script.remove(entry)
                return entry['status'], entry['headers'], dict(object='error', status=entry['status'], code='scripted', message=f'failed {auth}')
        if auth != f'Bearer {self.token}':
            return 401, {}, dict(object='error', status=401, code='unauthorized', message=f'API token is invalid. {auth}')
        size = int((body or query).get('page_size', 100))
        cursor = (body or query).get('start_cursor')
        if path == '/v1/users/me':
            return 200, {}, self.users[-1]
        if path == '/v1/users':
            return 200, {}, self.listing(self.users, cursor, size)
        found = re.fullmatch(r'/v1/pages/([0-9a-f-]+)', path)
        if found:
            page = self.pages.get(found.group(1))
            return (200, {}, page) if page else (404, {}, self.not_found(auth))
        found = re.fullmatch(r'/v1/blocks/([0-9a-f-]+)/children', path)
        if found:
            if found.group(1) not in self.pages and found.group(1) not in self.index:
                return 404, {}, self.not_found(auth)
            return 200, {}, self.listing(self.blocks.get(found.group(1), []), cursor, size)
        found = re.fullmatch(r'/v1/databases/([0-9a-f-]+)/query', path)
        if found and method == 'POST':
            if found.group(1) not in self.rows:
                return 404, {}, self.not_found(auth)
            rows = self.rows[found.group(1)]
            after = ((body or {}).get('filter') or {}).get('last_edited_time', {}).get('after')
            if after and not self.ignore_filter:
                rows = [r for r in rows if at(r['last_edited_time']) > at(after)]
            return 200, {}, self.listing(rows, cursor, size)
        return 404, {}, self.not_found(auth)

    @staticmethod
    def not_found(auth):
        return dict(object='error', status=404, code='object_not_found', message=f'Could not find it. {auth}')

    def listing(self, items, cursor, size):
        start = int(cursor or 0)
        chunk = items[start:start + min(size, self.per_page)]
        more = start + len(chunk) < len(items)
        return dict(object='list', results=chunk, has_more=more, next_cursor=str(start + len(chunk)) if more else None)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.reply('GET')

    def do_POST(self):
        self.reply('POST')

    def reply(self, method):
        fake = self.server.fake
        parts = urllib.parse.urlsplit(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()}
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        auth = self.headers.get('Authorization')
        fake.requests.append(dict(method=method, path=parts.path, query=query, body=body, auth=auth,
                                  version=self.headers.get('Notion-Version'), type=self.headers.get('Content-Type')))
        status, headers, payload = fake.answer(method, parts.path, query, body, auth)
        data = json.dumps(payload).encode()
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name.replace('_', '-'), value)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@contextmanager
def fake_notion():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    srv.fake = FakeNotion()
    thread = threading.Thread(target=srv.serve_forever, args=(.05,), daemon=True)
    thread.start()
    try:
        yield srv.fake, f'http://127.0.0.1:{srv.server_port}'
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


class FakeClock:
    """What the connector waits on: sleeping moves this clock and nothing else, so no check waits for real."""

    def __init__(self):
        self.time, self.sleeps = 1000.0, []

    def now(self):
        return self.time

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.time += seconds


def view(documents):
    """[(title, [(heading, text, author_is_me)])] of the documents."""
    return [(d['title'], [(s['heading'], s['text'], s['author_is_me']) for s in d['sections']]) for d in documents]


class NotionFixture(PipelineFixture):
    """A pipeline, a fake Notion the connector is pointed at, a clock that does not wait, and the real provider."""

    def setUp(self):
        super().setUp()
        configure(self.pipeline, dict(turnsPerBatch=10))
        self.provider = notion.NotionProvider()
        patcher = patch.dict(base.PROVIDERS, {'notion': self.provider}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fake, self.address = self.enterContext(fake_notion())
        self.enterContext(patch.dict(os.environ, {notion.API_ENV: self.address}))
        self.clock = FakeClock()
        self.enterContext(patch.object(notion, '_clock', self.clock.now))
        self.enterContext(patch.object(notion, '_sleep', self.clock.sleep))
        self.enterContext(patch.object(notion, '_next_turn', 0.0))
        self.enterContext(patch.object(notion, '_now', lambda: NOW))
        self.state = base.state_dir(self.pipeline)
        self.root = self.fake.add_page('프로젝트 노트')

    def save(self, token=TOKEN, **settings):
        base.save_token(self.state, 'notion', dict(token=token, **settings))

    def mine(self, **settings):
        self.save(user_id=ME, **settings)

    def settings(self):
        return base.load_token(self.state, 'notion')

    def fetch(self, scope_id=None, cursor=None):
        return self.provider.fetch(self.pipeline, dict(team_id='a', site='notion', scope_id=scope_id or self.root, cursor=cursor))

    def scope(self, scope_id=None, enabled=True):
        return base.set_scope(self.pipeline, 'notion', scope_id or self.root, '프로젝트 노트', enabled)

    def scope_row(self, scope_id=None):
        with connect(self.db) as c:
            return dict(c.execute('SELECT * FROM connector_scopes WHERE scope_id=?', (scope_id or self.root,)).fetchone())

    def intake(self):
        with connect(self.db) as c:
            return [json.loads(r[0]) for r in c.execute('SELECT message FROM intake ORDER BY rowid')]

    def quietly(self):
        return self.assertLogs('syncup', 'WARNING')


class PageIds(unittest.TestCase):
    ID = '0123456789abcdef0123456789abcdef'
    DASHED = '01234567-89ab-cdef-0123-456789abcdef'

    def test_addresses_and_bare_ids_become_one_dashed_id(self):
        for text in (f'https://www.notion.so/workspace/Team-Notes-{self.ID}?pvs=4', f'https://www.notion.so/{self.ID}',
                     f'https://notion.so/Title-{self.ID}', f'https://team.notion.site/Title-{self.ID}#{"a" * 32}',
                     f'www.notion.so/ws/T-{self.ID}', f'  https://www.notion.so/{self.ID}  ', self.ID, self.ID.upper(), self.DASHED,
                     f'https://www.notion.so/ws/{"b" * 32}?v={"c" * 32}&p={self.ID}&pm=s'):
            with self.subTest(text=text[:50]):
                self.assertEqual(notion.parse_page_id(text), self.DASHED)

    def test_other_text_is_refused_in_korean(self):
        for text in ('', '  ', 'hello', f'https://example.com/{self.ID}', f'https://notion.so.evil.example/{self.ID}',
                     'https://www.notion.so/workspace', f'https://www.notion.so/ws/{self.ID[:-1]}', self.ID[:-1], self.ID + 'a',
                     'https://[bad', None, 5):
            with self.subTest(text=str(text)[:40]), self.assertRaises(ValueError) as refused:
                notion.parse_page_id(text)
            self.assertTrue(re.search('[가-힣]', str(refused.exception)))

    def test_a_box_of_addresses_gives_distinct_ids_in_order(self):
        ids = notion.parse_pages(f'https://www.notion.so/A-{self.ID}\n{"f" * 32}, {self.ID}\n\n')
        self.assertEqual(ids, [self.DASHED, 'ffffffff-ffff-ffff-ffff-ffffffffffff'])
        self.assertEqual(notion.parse_pages(''), [])
        with self.assertRaises(ValueError):
            notion.parse_pages(f'{self.ID}\nnot a page')
        with self.assertRaises(ValueError):
            notion.parse_pages(' '.join(f'{i:032x}' for i in range(notion.MAX_SETUP_PAGES + 1)))


class Setup(NotionFixture):
    def test_the_form_has_the_inputs_and_asks_notion_nothing_before_a_token_is_saved(self):
        html = self.provider.setup_html(self.pipeline)
        for needle in ('name="token"', 'type="password"', 'name="pages"', 'name="owner"', '작성자를 알 수 없는 블록도 문서 담당자로서 가져오기'):
            self.assertIn(needle, html)
        self.assertNotIn('name="user_id"', html)
        self.assertNotIn('<form', html)
        self.assertEqual(self.fake.requests, [])

    def test_a_wrong_token_is_refused_and_nothing_is_saved(self):
        self.fake.token = 'ntn_SomeOtherTokenValue987654321'
        with self.assertRaisesRegex(ValueError, '받아들이지') as refused:
            self.provider.handle_setup(self.pipeline, dict(token=TOKEN))
        self.assertNotIn(TOKEN, str(refused.exception))
        self.assertIsNone(self.settings())
        self.assertEqual([(r['path'], r['auth']) for r in self.fake.requests], [('/v1/users/me', f'Bearer {TOKEN}')])

    def test_a_token_that_is_not_shaped_like_one_never_leaves_the_pc(self):
        for token in ('short', 'has space inside ok1234', 'line\nbreak_1234567890', 'x' * 400, '토큰토큰토큰토큰토큰토큰'):
            with self.subTest(token=token[:12]), self.assertRaisesRegex(ValueError, '토큰 모양'):
                self.provider.handle_setup(self.pipeline, dict(token=token))
        self.assertEqual(self.fake.requests, [])

    def test_a_good_token_is_checked_with_users_me_and_saved_privately(self):
        message = self.provider.handle_setup(self.pipeline, dict(token=f' {TOKEN}\n'))
        self.assertIn('저장했습니다', message)
        self.assertIn('내 노션 사용자', message, 'the next step is named')
        self.assertEqual(self.settings(), dict(token=TOKEN, owner=False))
        if sys.platform != 'win32':
            self.assertEqual(stat.S_IMODE((self.state / 'connectors' / 'notion.json').stat().st_mode), 0o600)
        request, = self.fake.requests
        self.assertEqual((request['method'], request['path'], request['auth'], request['version']),
                         ('GET', '/v1/users/me', f'Bearer {TOKEN}', '2022-06-28'))
        self.assertNotIn(TOKEN, message)

    def test_an_empty_token_box_keeps_the_saved_token(self):
        with self.assertRaisesRegex(ValueError, '토큰을 입력'):
            self.provider.handle_setup(self.pipeline, {})
        self.mine()
        self.provider.handle_setup(self.pipeline, dict(owner='1'))
        self.assertEqual(self.settings(), dict(token=TOKEN, owner=True, user_id=ME))
        self.assertEqual(self.fake.requests, [], 'nothing to check: the token was not typed again')

    def test_page_addresses_become_scopes_titled_from_the_page(self):
        second = self.fake.add_page('회의록')
        text = f'https://www.notion.so/ws/노트-{self.root.replace("-", "")}?pvs=4\n{second.replace("-", "")}'
        message = self.provider.handle_setup(self.pipeline, dict(token=TOKEN, pages=text, owner='1'))
        self.assertIn('프로젝트 노트', message)
        self.assertIn('회의록', message)
        self.assertEqual([(s['scope_id'], s['title'], s['enabled']) for s in base.list_scopes(self.pipeline, 'notion')],
                         [(self.root, '프로젝트 노트', 1), (second, '회의록', 1)])
        self.provider.handle_setup(self.pipeline, dict(pages=self.root, owner='1'))
        self.assertEqual(len(base.list_scopes(self.pipeline, 'notion')), 2, 'adding a page twice is one scope')

    def test_a_page_the_integration_cannot_see_is_named_and_the_rest_is_kept(self):
        with self.assertRaises(ValueError) as refused:
            self.provider.handle_setup(self.pipeline, dict(token=TOKEN, pages=f'{"deadbeef" * 4}\n{self.root}'))
        text = str(refused.exception)
        for needle in ('저장했습니다', '추가하지 못한 페이지', 'deadbeef-dead-beef-dead-beefdeadbeef', '공유'):
            self.assertIn(needle, text)
        self.assertNotIn(TOKEN, text)
        self.assertEqual(self.settings()['token'], TOKEN)
        self.assertEqual([s['scope_id'] for s in base.list_scopes(self.pipeline, 'notion')], [self.root])

    def test_an_address_that_is_not_notion_stops_everything_before_it_is_saved(self):
        with self.assertRaises(ValueError):
            self.provider.handle_setup(self.pipeline, dict(token=TOKEN, pages='https://example.com/page'))
        self.assertIsNone(self.settings())
        self.assertEqual(self.fake.requests, [])

    def test_the_team_record_page_and_a_trashed_page_cannot_be_added_as_scopes(self):
        record = self.fake.add_page('SyncUp 팀 기록 — 우리 팀')
        archived = self.fake.add_page('옛 페이지')
        self.fake.pages[archived]['archived'] = True
        with self.assertRaises(ValueError) as refused:
            self.provider.handle_setup(self.pipeline, dict(token=TOKEN, pages=f'{record}\n{archived}', owner='1'))
        self.assertIn('팀 기록', str(refused.exception))
        self.assertIn('휴지통', str(refused.exception))
        self.assertEqual(base.list_scopes(self.pipeline, 'notion'), [])

    def test_the_people_list_has_people_only_and_is_escaped(self):
        self.fake.users.insert(1, person(OTHER[:-1] + '9', '<script>alert(1)</script>', 'x@example.invalid'))
        self.mine()
        html = self.provider.setup_html(self.pipeline)
        self.assertIn('name="user_id"', html)
        self.assertIn('name="users_shown"', html)
        self.assertIn(f'<option value="{ME.replace("-", "")}" selected>나 (me@example.invalid)</option>', html)
        self.assertIn('>남</option>', html)
        self.assertNotIn('>통합</option>', html, 'bots are not people')
        self.assertIn('&lt;script&gt;', html)
        self.assertNotIn('<script>', html)
        self.assertNotIn(ME, html, 'the dashed id is what the token file holds, and what the page would blank')
        self.assertNotIn(TOKEN, html)

    def test_more_than_one_page_of_people_is_read(self):
        self.fake.per_page = 1
        self.mine()
        html = self.provider.setup_html(self.pipeline)
        self.assertIn('>나 (me@example.invalid)</option>', html)
        self.assertIn('>남</option>', html)
        self.assertEqual([r['query'].get('start_cursor') for r in self.fake.seen('/v1/users')], [None, '1', '2'])

    def test_a_list_that_cannot_be_read_leaves_the_form_without_the_select(self):
        self.mine()
        self.fake.fail('/v1/users', 500, times=None)
        html = self.provider.setup_html(self.pipeline)
        self.assertIn('name="token"', html)
        self.assertNotIn('name="user_id"', html)
        self.assertNotIn('users_shown', html)
        self.fake.script.clear()
        self.provider.handle_setup(self.pipeline, dict(owner='1'))
        self.assertEqual(self.settings()['user_id'], ME, 'a choice that was not on the form is not erased')

    def test_choosing_keeping_and_clearing_my_user(self):
        self.save()
        self.provider.handle_setup(self.pipeline, dict(users_shown='1', user_id=ME.replace('-', '').upper()))
        self.assertEqual(self.settings(), dict(token=TOKEN, owner=False, user_id=ME), 'stored dashed, lower case')
        self.provider.handle_setup(self.pipeline, dict(owner='1'))
        self.assertEqual(self.settings()['user_id'], ME)
        self.provider.handle_setup(self.pipeline, dict(users_shown='1'))
        self.assertNotIn('user_id', self.settings())
        for odd in ('someone', ME[:-1], '<b>'):
            with self.subTest(odd=odd), self.assertRaisesRegex(ValueError, '사용자'):
                self.provider.handle_setup(self.pipeline, dict(users_shown='1', user_id=odd))

    def test_the_owner_checkbox(self):
        self.save()
        self.assertNotIn(' checked', self.provider.setup_html(self.pipeline))
        self.provider.handle_setup(self.pipeline, dict(owner='1'))
        self.assertIs(self.settings()['owner'], True)
        self.assertIn(' checked', self.provider.setup_html(self.pipeline))
        self.provider.handle_setup(self.pipeline, {})
        self.assertIs(self.settings()['owner'], False, 'a box that is not ticked is not in the form')

    def test_the_status_names_the_next_step_and_never_the_token(self):
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=False, tokenSet=False, needs=notion.NEEDS_TOKEN))
        self.assertIn('통합', notion.NEEDS_TOKEN)
        self.save()
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=True, tokenSet=True, needs=notion.NEEDS_USER))
        self.mine()
        self.assertEqual(self.provider.status(self.pipeline)['needs'], notion.NEEDS_PAGE)
        self.assertIn('통합에 페이지를 공유하세요', notion.NEEDS_PAGE)
        self.scope()
        self.assertEqual(self.provider.status(self.pipeline), dict(connected=True, tokenSet=True, needs=None))
        for error, needs in (('not_found 404', notion.NEEDS_SHARE), ('forbidden 403', notion.NEEDS_SHARE),
                             ('unauthorized 401', notion.NEEDS_TOKEN_AGAIN), ('rate_limit 429', None)):
            with self.subTest(error=error):
                with self.pipeline.write() as c:
                    c.execute('UPDATE connector_scopes SET last_error=?', (error,))
                self.assertEqual(self.provider.status(self.pipeline)['needs'], needs)
        self.save(owner=True)
        with self.pipeline.write() as c:
            c.execute('UPDATE connector_scopes SET last_error=NULL')
        self.assertIsNone(self.provider.status(self.pipeline)['needs'], 'owner mode needs no user')
        self.assertNotIn(TOKEN, json.dumps(self.provider.status(self.pipeline)))

    def test_disconnect_deletes_the_token_file_only(self):
        self.mine()
        self.scope()
        base.disconnect(self.pipeline, 'notion')
        self.assertFalse((self.state / 'connectors' / 'notion.json').exists())
        self.assertEqual(len(base.list_scopes(self.pipeline, 'notion')), 1)
        status = self.provider.status(self.pipeline)
        self.assertEqual((status['connected'], status['tokenSet']), (False, False))
        self.assertIn('노션 설정', status['needs'], 'remove the integration in Notion too')
        self.assertEqual(self.fake.requests, [], 'there is no call to revoke an internal integration')


class Conversion(NotionFixture):
    def build(self):
        f, root = self.fake, self.root
        f.add_block(root, 'heading_1', '개요')
        f.add_block(root, 'paragraph', 'SQLite로 결정했다.')
        bullet = f.add_block(root, 'bulleted_list_item', '로그인 먼저')
        f.add_block(bullet, 'bulleted_list_item', '세부: OAuth')
        for text in ('첫째', '둘째', '셋째'):
            f.add_block(root, 'numbered_list_item', text)
        f.add_block(root, 'paragraph', '끝')
        f.add_block(root, 'numbered_list_item', '다시')
        f.add_block(root, 'to_do', '배포', checked=True)
        f.add_block(root, 'to_do', '문서', checked=False)
        toggle = f.add_block(root, 'toggle', '더 보기')
        f.add_block(toggle, 'paragraph', '숨은 내용')
        f.add_block(root, 'quote', '말은 쉽다')
        f.add_block(root, 'callout', '주의: 금요일 마감', icon=dict(type='emoji', emoji='⚠️'))
        f.add_block(root, 'code', 'print(1)', language='python')
        f.add_block(root, 'code', '메모', language='plain text')
        f.add_block(root, 'divider')
        f.add_block(root, 'image', type='external', external=dict(url='https://example.invalid/a.png'))
        f.add_block(root, 'paragraph', '')
        f.add_block(root, 'heading_2', '표')
        f.table(root, [['이름', '역할'], ['김', '백엔드']])
        f.add_block(root, 'heading_3', '링크')
        sub = f.child_page(root, '하위 페이지')
        f.add_block(sub, 'paragraph', 'SUBPAGE_TEXT')
        database = f.child_database(root, '할 일')
        f.add_row(database, dict(이름=prop('title', rich('로그인 만들기')), 상태=prop('select', dict(name='진행 중')),
                                 담당=prop('people', [person(ME, '김')]), 마감=prop('date', dict(start='2026-11-20', end=None)),
                                 완료=prop('checkbox', False), 메모=prop('rich_text', []), 점수=prop('number', 3),
                                 관계=prop('relation', [dict(id='x')])))
        f.add_row(database, dict(이름=prop('title', rich('DB 설계')), 상태=prop('status', dict(name='완료')),
                                 태그=prop('multi_select', [dict(name='백엔드'), dict(name='DB')]),
                                 공식=prop('formula', dict(type='string', string='계산됨'))), by=OTHER)
        return sub, database

    def test_blocks_become_sections_pages_and_databases_become_documents(self):
        sub, database = self.build()
        self.fake.per_page = 3  # the children of every block come in pieces of three: start_cursor is followed
        self.mine()
        documents, cursor = self.fetch()
        self.assertEqual(view(documents), [
            ('프로젝트 노트', [
                ('# 개요', 'SQLite로 결정했다.\n- 로그인 먼저\n  - 세부: OAuth\n1. 첫째\n2. 둘째\n3. 셋째\n끝\n1. 다시\n[x] 배포\n[ ] 문서\n'
                           '더 보기\n  숨은 내용\n> 말은 쉽다\n주의: 금요일 마감\n```python\nprint(1)\n```\n```\n메모\n```', True),
                ('## 표', '이름\t역할\n김\t백엔드', True)]),
            ('하위 페이지', [('', 'SUBPAGE_TEXT', True)]),
            ('할 일', [('할 일', '이름: 로그인 만들기\n상태: 진행 중\n담당: 김\n마감: 2026-11-20\n완료: 아니오\n점수: 3', True),
                      ('할 일', '이름: DB 설계\n상태: 완료\n태그: 백엔드, DB\n공식: 계산됨', False)]),
        ])
        root, child, table = documents
        self.assertEqual((root['source_id'], child['source_id'], table['source_id']), (self.root, sub, database))
        self.assertEqual(root['modified'], datetime(2026, 11, 10, 9, 0, tzinfo=UTC))
        self.assertEqual(root['url'], 'https://www.notion.so/' + self.root.replace('-', ''))
        self.assertEqual(cursor, '2026-11-10T09:00:00+00:00')
        listed = self.fake.seen(f'/blocks/{self.root}/children')
        self.assertEqual([r['query'].get('start_cursor') for r in listed][:3], [None, '3', '6'])
        self.assertTrue(all(r['query']['page_size'] == '100' for r in listed))
        for document in documents:
            for message in base.build_messages('notion', document):
                self.assertLessEqual(len(message['text']), 2000)

    def test_a_page_with_nothing_to_say_makes_no_document(self):
        self.fake.add_block(self.root, 'divider')
        self.fake.add_block(self.root, 'heading_1', '제목만')
        self.mine()
        self.assertEqual(self.fetch(), ([], '2026-11-10T09:00:00+00:00'))

    def test_deeper_blocks_nest_but_stop_at_a_limit(self):
        parent = self.root
        for n in range(notion.MAX_BLOCK_DEPTH + 3):
            parent = self.fake.add_block(parent, 'toggle', f'단계 {n}')
        self.mine()
        documents, cursor = self.fetch()
        text = documents[0]['sections'][0]['text']
        self.assertIn('단계 0', text)
        self.assertIn(f'단계 {notion.MAX_BLOCK_DEPTH}', text)
        self.assertNotIn(f'단계 {notion.MAX_BLOCK_DEPTH + 2}', text)
        self.assertIsNone(cursor, 'something was left unread: the cursor stays')

    def test_child_pages_are_read_to_a_depth_and_a_count(self):
        page = self.root
        for n in range(5):
            page = self.fake.child_page(page, f'깊이 {n + 1}')
            self.fake.add_block(page, 'paragraph', f'본문 {n + 1}')
        self.mine()
        documents, cursor = self.fetch()
        self.assertEqual([d['title'] for d in documents], ['깊이 1', '깊이 2', '깊이 3'], 'the root has no text; three levels below it')
        self.assertIsNone(cursor)
        with patch.object(notion, 'MAX_PAGES', 2):
            documents, cursor = self.fetch()
        self.assertEqual([d['title'] for d in documents], ['깊이 1'])
        self.assertIsNone(cursor)

    def test_an_archived_or_unreadable_child_is_left_out_without_stopping_the_rest(self):
        gone = self.fake.child_page(self.root, '지워진 페이지')
        self.fake.add_block(gone, 'paragraph', 'GONE_TEXT')
        self.fake.pages[gone]['archived'] = True
        hidden = self.fake.child_page(self.root, '공유 안 된 페이지')
        del self.fake.pages[hidden]  # the block is listed, the page is not shown to the integration
        kept = self.fake.child_page(self.root, '남는 페이지')
        self.fake.add_block(kept, 'paragraph', 'KEPT_TEXT')
        self.mine()
        documents, cursor = self.fetch()
        self.assertEqual([d['title'] for d in documents], ['남는 페이지'])
        self.assertNotIn('GONE_TEXT', json.dumps(documents, default=str, ensure_ascii=False))
        self.assertEqual(cursor, '2026-11-10T09:00:00+00:00')

    def test_a_database_notion_refuses_is_left_out_but_a_bad_token_still_stops_the_run(self):
        broken = self.fake.child_database(self.root, '막힌 표')
        self.fake.add_row(broken, dict(이름=prop('title', rich('BROKEN_ROW'))))
        fine = self.fake.child_database(self.root, '열린 표')
        self.fake.add_row(fine, dict(이름=prop('title', rich('FINE_ROW'))))
        self.mine()
        self.fake.fail(f'/databases/{broken}/query', 400)
        documents, _ = self.fetch()
        self.assertEqual(view(documents), [('열린 표', [('열린 표', '이름: FINE_ROW', True)])])
        self.fake.fail(f'/databases/{fine}/query', 401)
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual(stopped.exception.kind, 'unauthorized')

    def test_database_property_values_as_text(self):
        self.assertEqual(notion._value(prop('number', 2.5)), '2.5')
        self.assertEqual(notion._value(prop('date', dict(start='2026-11-20', end='2026-11-22'))), '2026-11-20 → 2026-11-22')
        self.assertEqual(notion._value(prop('checkbox', True)), '예')
        self.assertEqual(notion._value(prop('formula', dict(type='number', number=7))), '7')
        self.assertEqual(notion._value(prop('formula', dict(type='boolean', boolean=True))), '예')
        for kind, value in (('files', []), ('relation', [dict(id='x')]), ('rollup', dict(type='array')), ('created_time', EDIT),
                            ('select', None), ('number', None), ('date', None), ('url', None), ('mystery', 1)):
            with self.subTest(kind=kind):
                self.assertEqual(notion._value(prop(kind, value)), '')
        self.assertEqual(notion._value('x'), '')


class Authors(NotionFixture):
    def test_every_block_is_mine_theirs_or_unknown_and_a_section_never_mixes(self):
        f = self.fake
        f.add_block(self.root, 'paragraph', 'MINE_A', by=ME)
        f.add_block(self.root, 'paragraph', 'THEIRS', by=OTHER)
        f.add_block(self.root, 'paragraph', 'MINE_B', by=ME)
        fallback = f.add_block(self.root, 'paragraph', 'MINE_FALLBACK', by=OTHER)  # no last_edited_by: created_by decides
        f.index[fallback]['created_by'] = user(ME)
        del f.index[fallback]['last_edited_by']
        nobody = f.add_block(self.root, 'paragraph', 'WITH_NO_AUTHOR')  # not provably mine
        del f.index[nobody]['created_by'], f.index[nobody]['last_edited_by']
        edited = f.add_block(self.root, 'paragraph', 'WRITTEN_BY_ME_EDITED_BY_OTHER', by=ME)
        f.index[edited]['last_edited_by'] = user(OTHER)
        self.mine()
        documents, _ = self.fetch()
        sections = documents[0]['sections']
        self.assertEqual([(s['text'], s['author_is_me']) for s in sections],
                         [('MINE_A', True), ('THEIRS', False), ('MINE_B\nMINE_FALLBACK', True),
                          ('WITH_NO_AUTHOR\nWRITTEN_BY_ME_EDITED_BY_OTHER', False)])
        for section in sections:
            self.assertIs(type(section['author_is_me']), bool, 'exactly True or False, never a look-alike')
        self.assertEqual([m['text'] for m in base.build_messages('notion', documents[0])], ['MINE_A', 'MINE_B\nMINE_FALLBACK'])

    def test_a_heading_belongs_to_the_author_of_the_heading(self):
        f = self.fake
        f.add_block(self.root, 'heading_2', 'THEIR_HEADING', by=OTHER)
        f.add_block(self.root, 'paragraph', 'MY_TEXT', by=ME)
        f.add_block(self.root, 'heading_2', '내 제목', by=ME)
        f.add_block(self.root, 'paragraph', 'THEIR_TEXT', by=OTHER)
        f.add_block(self.root, 'paragraph', 'MY_TEXT_2', by=ME)
        self.mine()
        documents, _ = self.fetch()
        self.assertEqual([(s['heading'], s['text'], s['author_is_me']) for s in documents[0]['sections']],
                         [('', 'MY_TEXT', True), ('', 'THEIR_TEXT', False), ('', 'MY_TEXT_2', True)])
        mine = ' '.join(m['text'] for m in base.build_messages('notion', documents[0]))
        self.assertNotIn('THEIR', mine)

    def test_nested_blocks_and_table_rows_are_judged_one_by_one(self):
        f = self.fake
        item = f.add_block(self.root, 'bulleted_list_item', '내 항목', by=ME)
        f.add_block(item, 'bulleted_list_item', '남이 덧붙인 하위 항목', by=OTHER)
        f.add_block(item, 'bulleted_list_item', '내 하위 항목', by=ME)
        f.table(self.root, [['a', 'b']], by=OTHER)
        self.mine()
        documents, _ = self.fetch()
        self.assertEqual([(s['text'], s['author_is_me']) for s in documents[0]['sections']],
                         [('- 내 항목', True), ('  - 남이 덧붙인 하위 항목', False), ('  - 내 하위 항목', True), ('a\tb', False)])

    def test_the_owner_checkbox_makes_unknown_authors_the_documents_owner(self):
        f = self.fake
        f.add_block(self.root, 'heading_1', '첫 제목', by=OTHER)
        f.add_block(self.root, 'paragraph', '누가 썼는지 모른다', by=OTHER)
        f.add_block(self.root, 'heading_1', '둘째 제목', by=ME)
        f.add_block(self.root, 'paragraph', '이것도', by=ME)
        self.save(owner=True)
        documents, _ = self.fetch()
        sections = documents[0]['sections']
        self.assertEqual([(s['heading'], s['text'], s['author_is_me']) for s in sections],
                         [('# 첫 제목', '누가 썼는지 모른다', None), ('# 둘째 제목', '이것도', None)])
        self.assertTrue(all(s['author_is_me'] is None for s in sections), 'split at headings only: nobody to tell apart')
        self.assertEqual(len(base.build_messages('notion', documents[0])), 2)

    def test_my_user_decides_even_when_the_checkbox_is_on(self):
        self.fake.add_block(self.root, 'paragraph', 'THEIRS', by=OTHER)
        self.mine(owner=True)
        documents, _ = self.fetch()
        self.assertEqual([s['author_is_me'] for s in documents[0]['sections']], [False])

    def test_without_my_user_and_without_the_checkbox_nothing_is_read(self):
        self.fake.add_block(self.root, 'paragraph', 'ANY_TEXT', by=ME)
        for settings in (dict(), dict(owner=False)):
            self.save(**settings)
            with self.subTest(settings=settings), self.assertRaises(base.ConnectorError) as stopped:
                self.fetch()
            self.assertEqual((stopped.exception.kind, stopped.exception.status), ('author_unset', None))
            self.assertEqual(base.error_kind(stopped.exception), 'author_unset')
        self.assertEqual(self.fake.requests, [], 'not one request: nobody to tell mine from theirs')


class TeamRecord(NotionFixture):
    def test_what_syncup_wrote_is_not_read_back(self):
        f = self.fake
        f.add_block(self.root, 'paragraph', 'ROOT_TEXT')
        by_title = f.child_page(self.root, 'SyncUp 팀 기록 — 우리 팀')
        f.add_block(by_title, 'paragraph', 'RECORD_BY_TITLE')
        under_title = f.child_page(by_title, '기록 아래')
        f.add_block(under_title, 'paragraph', 'UNDER_TITLE')
        korean = f.child_page(self.root, '싱크업 팀 기록 (2026-11-14)')
        f.add_block(korean, 'paragraph', 'RECORD_KOREAN')
        by_line = f.child_page(self.root, '제목은 평범함')
        f.add_block(by_line, 'heading_1', '싱크업 팀 기록 (11/14)')
        f.add_block(by_line, 'paragraph', 'RECORD_BY_FIRST_LINE')
        under_line = f.child_page(by_line, '기록 아래 둘')
        f.add_block(under_line, 'paragraph', 'UNDER_LINE')
        plain_hash = f.child_page(self.root, '또 다른 평범한 제목')
        f.add_block(plain_hash, 'paragraph', '# 싱크업 팀 기록 (11/14)')
        f.add_block(plain_hash, 'paragraph', 'RECORD_BY_HASH_LINE')
        normal = f.child_page(self.root, '일반 페이지')
        f.add_block(normal, 'paragraph', 'NORMAL_TEXT')
        self.mine()
        documents, cursor = self.fetch()
        self.assertEqual([d['title'] for d in documents], ['프로젝트 노트', '일반 페이지'])
        everything = json.dumps(documents, default=str, ensure_ascii=False)
        for text in ('RECORD_', 'UNDER_'):
            self.assertNotIn(text, everything)
        asked = ' '.join(r['path'] for r in f.requests)
        for page in (by_title, korean, under_title, under_line):
            self.assertNotIn(page, asked, 'never even requested')
        self.assertIsNotNone(cursor)

    def test_a_root_page_that_is_the_team_record_gives_nothing(self):
        self.fake.pages[self.root]['properties']['title']['title'] = rich('싱크업 팀 기록')
        self.fake.add_block(self.root, 'paragraph', 'RECORD_TEXT')
        self.mine()
        self.assertEqual(self.fetch()[0], [])
        self.assertEqual(self.fake.seen('/blocks/'), [])

    def test_a_page_that_only_mentions_the_record_is_read(self):
        self.fake.add_block(self.root, 'paragraph', '어제 싱크업 팀 기록을 봤다.')
        self.mine()
        self.assertEqual(len(self.fetch()[0]), 1)


class Cursor(NotionFixture):
    def tree(self):
        f = self.fake
        f.add_block(self.root, 'paragraph', 'ROOT_TEXT')
        self.a = f.child_page(self.root, '가', edited='2026-11-11T09:00:00.000Z')
        f.add_block(self.a, 'paragraph', 'A_TEXT')
        self.b = f.child_page(self.root, '나', edited='2026-11-09T09:00:00.000Z')
        f.add_block(self.b, 'paragraph', 'B_TEXT')
        self.mine()

    def test_the_cursor_is_the_newest_edit_and_unchanged_pages_are_skipped(self):
        self.tree()
        documents, cursor = self.fetch()
        self.assertEqual([d['title'] for d in documents], ['프로젝트 노트', '가', '나'])
        self.assertEqual(cursor, '2026-11-11T09:00:00+00:00')
        before = len(self.fake.requests)
        self.assertEqual(self.fetch(cursor=cursor), ([], None), 'nothing changed: no document and no new cursor')
        self.assertGreater(len(self.fake.requests), before, 'the pages are still walked: a child page may have changed')
        self.fake.add_block(self.b, 'paragraph', 'B_MORE')
        self.fake.pages[self.b]['last_edited_time'] = '2026-11-12T10:00:00.000Z'
        documents, newer = self.fetch(cursor=cursor)
        self.assertEqual([d['title'] for d in documents], ['나'], 'only the page that changed, though its parent did not')
        self.assertEqual(newer, '2026-11-12T10:00:00+00:00')
        self.assertEqual([d['modified'] for d in documents], [datetime(2026, 11, 12, 10, 0, tzinfo=UTC)])
        self.assertEqual(self.fetch(cursor=newer), ([], None))

    def test_a_page_edited_at_the_cursor_is_not_read_again(self):
        self.tree()
        self.assertEqual(self.fetch(cursor='2026-11-11T09:00:00+00:00')[0], [])
        self.assertEqual([d['title'] for d in self.fetch(cursor='2026-11-11T08:59:59+00:00')[0]], ['가'])
        self.assertEqual(len(self.fetch(cursor='not a time')[0]), 3, 'a cursor nobody can read starts over')

    def test_a_cursor_stays_behind_the_last_two_minutes(self):
        self.tree()
        self.fake.pages[self.a]['last_edited_time'] = '2026-11-14T23:59:30.000Z'
        _, cursor = self.fetch()
        self.assertEqual(cursor, '2026-11-14T23:58:00+00:00', 'two minutes before now: Notion rounds its times to the minute')
        documents, _ = self.fetch(cursor=cursor)
        self.assertEqual([d['title'] for d in documents], ['가'], 'so the page is read once more, and ingest skips what it has')

    def test_database_rows_are_filtered_by_the_cursor_twice(self):
        f = self.fake
        database = f.child_database(self.root, '표')
        f.add_row(database, dict(이름=prop('title', rich('옛 행'))), edited='2026-11-09T09:00:00.000Z')
        f.add_row(database, dict(이름=prop('title', rich('새 행'))), edited='2026-11-12T09:00:00.000Z')
        self.mine()
        documents, cursor = self.fetch()
        self.assertEqual(view(documents), [('표', [('표', '이름: 옛 행', True), ('표', '이름: 새 행', True)])])
        self.assertEqual(cursor, '2026-11-12T09:00:00+00:00')
        for ignores in (False, True):
            f.ignore_filter = ignores
            documents, _ = self.fetch(cursor='2026-11-10T00:00:00+00:00')
            self.assertEqual(view(documents), [('표', [('표', '이름: 새 행', True)])], f'server ignores the filter: {ignores}')
        queries = f.seen('/query')
        self.assertEqual(queries[-1]['body']['filter'],
                         dict(timestamp='last_edited_time', last_edited_time=dict(after='2026-11-10T00:00:00+00:00')))
        self.assertEqual((queries[0]['body'], queries[0]['method'], queries[0]['type']), (dict(page_size=100), 'POST', 'application/json'))

    def test_many_rows_are_read_by_pages_and_capped(self):
        f = self.fake
        f.per_page = 40
        database = f.child_database(self.root, '큰 표')
        for n in range(130):
            f.add_row(database, dict(이름=prop('title', rich(f'행 {n}'))))
        self.mine()
        documents, cursor = self.fetch()
        self.assertEqual(len(documents[0]['sections']), 130)
        self.assertEqual([r['body'].get('start_cursor') for r in f.seen('/query')], [None, '40', '80', '120'])
        self.assertIsNotNone(cursor)
        with patch.object(notion, 'MAX_ROWS', 100):
            documents, cursor = self.fetch()
        self.assertEqual(len(documents[0]['sections']), 100)
        self.assertIsNone(cursor, 'rows were left unread: the cursor stays')

    def test_a_run_that_runs_out_of_requests_stops_and_keeps_no_half_page(self):
        self.tree()
        with patch.object(notion, 'MAX_REQUESTS', 5):  # root page, its blocks, page 가, its blocks, page 나; its blocks are one too many
            documents, cursor = self.fetch()
        self.assertEqual([d['title'] for d in documents], ['프로젝트 노트', '가'])
        self.assertIsNone(cursor)
        self.assertEqual(len(self.fake.requests), 5)

    def test_run_scope_stores_the_cursor_and_hands_it_back(self):
        self.tree()
        self.scope()
        handed = []
        real = self.provider.fetch
        self.provider.fetch = lambda pipeline, scope: (handed.append(scope['cursor']), real(pipeline, scope))[1]
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root), dict(documents=3, sent=3, skipped=0))
        self.assertEqual(self.scope_row()['cursor'], '2026-11-11T09:00:00+00:00')
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root), dict(documents=0, sent=0, skipped=0))
        self.assertEqual(handed, [None, '2026-11-11T09:00:00+00:00'])
        self.assertEqual(self.scope_row()['cursor'], '2026-11-11T09:00:00+00:00', 'a run with no news keeps it')


class Http(NotionFixture):
    def setUp(self):
        super().setUp()
        self.mine()
        self.fake.add_block(self.root, 'paragraph', 'ROOT_TEXT')

    def test_every_request_carries_the_token_and_the_version(self):
        self.fetch()
        for request in self.fake.requests:
            self.assertEqual((request['auth'], request['version']), (f'Bearer {TOKEN}', '2022-06-28'))
        self.assertEqual([(r['method'], r['path']) for r in self.fake.requests],
                         [('GET', f'/v1/pages/{self.root}'), ('GET', f'/v1/blocks/{self.root}/children')])
        self.assertEqual(self.fake.requests[1]['query'], dict(page_size='100'))

    def test_requests_are_spaced_a_third_of_a_second_apart(self):
        api = notion._Api(TOKEN)
        for _ in range(3):
            api.get('users/me')
        self.assertEqual(len(self.clock.sleeps), 2)
        for slept in self.clock.sleeps:
            self.assertAlmostEqual(slept, 1 / 3, places=6)
        self.assertEqual(notion.REQUEST_INTERVAL, 1 / 3)
        self.assertEqual((REAL_SLEEP, REAL_CLOCK), (time.sleep, time.monotonic), 'outside these checks the real clock is used')

    def test_a_429_waits_as_long_as_retry_after_says_and_goes_on(self):
        self.fake.fail('/v1/pages/', 429, times=2, Retry_After='2')
        self.assertEqual(len(self.fetch()[0]), 1)
        self.assertEqual(len(self.fake.seen('/v1/pages/')), 3, 'the same request, three times')
        waits = [s for s in self.clock.sleeps if s > 1]
        self.assertEqual(len(waits), 2)
        for slept in waits:
            self.assertAlmostEqual(slept, 2.0, delta=.01)

    def test_a_429_without_a_usable_retry_after_waits_a_second(self):
        for header in ({}, dict(Retry_After='Fri, 13 Nov 2026 12:00:00 GMT')):
            with self.subTest(header=header):
                self.clock.sleeps.clear()
                self.fake.fail('/v1/pages/', 429, **header)
                self.assertEqual(len(self.fetch()[0]), 1)
                self.assertTrue(any(abs(s - 1.0) < .01 for s in self.clock.sleeps), self.clock.sleeps)

    def test_retries_are_bounded(self):
        self.fake.fail('/v1/pages/', 429, times=None, Retry_After='1')
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual((stopped.exception.kind, stopped.exception.status), ('rate_limit', 429))
        self.assertEqual(len(self.fake.seen('/v1/pages/')), notion.RATE_RETRIES + 1)
        self.assertEqual(base.error_kind(stopped.exception), 'rate_limit 429')

    def test_a_retry_after_that_is_too_long_is_not_waited_for(self):
        self.fake.fail('/v1/pages/', 429, times=None, Retry_After='3600')
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual(stopped.exception.kind, 'rate_limit')
        self.assertEqual(len(self.fake.seen('/v1/pages/')), 1)
        self.assertFalse([s for s in self.clock.sleeps if s > 1], 'it did not sleep an hour')

    def test_a_server_error_is_tried_again_twice_then_reported(self):
        self.fake.fail('/v1/pages/', 503)
        self.assertEqual(len(self.fetch()[0]), 1)
        self.assertEqual(len(self.fake.seen('/v1/pages/')), 2)
        self.fake.fail('/v1/pages/', 503, times=None)
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual((stopped.exception.kind, stopped.exception.status), ('server_error', 503))
        self.assertEqual(len(self.fake.seen('/v1/pages/')), 2 + notion.SERVER_RETRIES + 1)

    def test_401_403_404_and_the_rest_are_kinds_with_a_status(self):
        for status, kind in ((401, 'unauthorized'), (403, 'forbidden'), (404, 'not_found'), (400, 'bad_request'), (409, 'conflict'),
                             (418, 'http_error')):
            with self.subTest(status=status):
                self.fake.requests.clear()
                self.fake.fail('/v1/pages/', status)
                with self.assertRaises(base.ConnectorError) as stopped:
                    self.fetch()
                self.assertEqual((stopped.exception.kind, stopped.exception.status), (kind, status))
                self.assertEqual(len(self.fake.seen('/v1/pages/')), 1, 'not worth another try')

    def test_a_root_page_that_is_not_shared_is_not_found_not_a_crash(self):
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch('deadbeef-dead-beef-dead-beefdeadbeef')
        self.assertEqual(base.error_kind(stopped.exception), 'not_found 404')

    def test_a_scope_may_be_typed_as_an_address_and_a_bad_one_is_an_error(self):
        address = f'https://www.notion.so/ws/노트-{self.root.replace("-", "")}'
        self.assertEqual(len(self.fetch(address)[0]), 1)
        self.assertEqual(self.fake.requests[0]['path'], f'/v1/pages/{self.root}', 'the id is used, the address never')
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch('https://example.com/x')
        self.assertEqual(stopped.exception.kind, 'bad_scope')

    def test_no_server_is_a_network_error(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        with patch.dict(os.environ, {notion.API_ENV: f'http://127.0.0.1:{port}'}), self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual((stopped.exception.kind, stopped.exception.status), ('network', None))

    def test_an_answer_that_is_not_an_object_or_is_too_big_is_refused(self):
        original = self.fake.answer
        self.fake.answer = lambda *args: (200, {}, ['not', 'an', 'object'])
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual(stopped.exception.kind, 'bad_response')
        self.fake.answer = original
        with patch.object(notion, 'MAX_RESPONSE', 20), self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual(stopped.exception.kind, 'too_large')

    def test_a_redirect_is_not_followed_so_the_token_goes_nowhere_else(self):
        with fake_notion() as (elsewhere, elsewhere_address):
            self.fake.fail('/v1/pages/', 302, Location=elsewhere_address + '/v1/pages/x')
            with self.assertRaises(base.ConnectorError) as stopped:
                self.fetch()
            self.assertEqual((stopped.exception.kind, stopped.exception.status), ('http_error', 302))
            self.assertEqual(elsewhere.requests, [])

    def test_the_token_only_goes_to_an_address_that_is_safe_for_it(self):
        for address, kind in (('http://notion.example.com', 'insecure_api'), ('http://192.0.2.1:9', 'insecure_api'), ('ftp://x', 'config'),
                              ('https://user:pw@api.example.com', 'config'), ('https://api.example.com?x=1', 'config'),
                              ('notion', 'config'), ('http://127.0.0.1:99999', 'config')):
            with self.subTest(address=address), patch.dict(os.environ, {notion.API_ENV: address}), \
                    self.assertRaises(base.ConnectorError) as stopped:
                self.fetch()
            self.assertEqual(stopped.exception.kind, kind)
        self.assertEqual(self.fake.requests, [])
        with patch.dict(os.environ, {notion.API_ENV: ''}):
            self.assertEqual(notion._api_base(), (REAL_API, False), 'the default is the real API, over https')
        self.assertEqual(REAL_API, 'https://api.notion.com')

    def test_the_stored_token_must_look_like_one_or_nothing_is_sent(self):
        self.save(token='bad token\r\nX-Evil: 1', user_id=ME)
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual(stopped.exception.kind, 'unauthorized')
        base.delete_token(self.state, 'notion')
        with self.assertRaises(base.ConnectorError) as stopped:
            self.fetch()
        self.assertEqual(stopped.exception.kind, 'unauthorized')
        self.assertEqual(self.fake.requests, [])

    def test_no_error_carries_the_token_a_url_or_what_notion_answered(self):
        self.fake.token = REVOKED  # every answer now says "API token is invalid. Bearer <our token>"
        failures = []
        for call in (self.fetch, lambda: notion._Api(TOKEN).get('users/me'), lambda: notion._Api(TOKEN).post('databases/x/query', {})):
            with self.assertRaises(base.ConnectorError) as stopped:
                call()
            failures += [str(stopped.exception), repr(stopped.exception), base.error_kind(stopped.exception), str(stopped.exception.args)]
        self.assertEqual(failures[2], 'unauthorized 401')
        for text in failures:
            for secret in (TOKEN, 'Bearer', 'invalid', '127.0.0.1', '/v1/'):
                self.assertNotIn(secret, text)
        with self.assertRaises(ValueError) as refused:
            self.provider.handle_setup(self.pipeline, dict(token=TOKEN))
        self.assertNotIn(TOKEN, str(refused.exception))
        self.assertNotIn('Bearer', str(refused.exception))


class EndToEnd(NotionFixture):
    """base.run_scope with the real provider: Notion -> documents -> turn_intake."""

    def test_run_scope_hands_my_text_to_turn_intake_and_nothing_else(self):
        f = self.fake
        f.add_block(self.root, 'heading_1', '결정')
        f.add_block(self.root, 'paragraph', 'MINE 우리는 SQLite를 쓴다.')
        f.add_block(self.root, 'paragraph', 'OTHER_AUTHOR_CANARY 남이 쓴 결정', by=OTHER)
        f.add_block(self.root, 'paragraph', 'MINE 금요일까지 공유한다.')
        sub = f.child_page(self.root, '회의록', edited='2026-11-11T09:00:00.000Z')
        f.add_block(sub, 'paragraph', 'MINE 하위 페이지의 결정')
        f.add_block(sub, 'paragraph', 'OTHER_AUTHOR_CANARY 하위 페이지의 남의 글', by=OTHER)
        record = f.child_page(self.root, '싱크업 팀 기록')
        f.add_block(record, 'paragraph', 'RECORD_CANARY')
        message = self.provider.handle_setup(self.pipeline, dict(token=TOKEN, pages=f'https://www.notion.so/노트-{self.root.replace("-", "")}'))
        self.assertIn('프로젝트 노트', message)
        self.provider.handle_setup(self.pipeline, dict(users_shown='1', user_id=ME.replace('-', '')))
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root), dict(documents=2, sent=3, skipped=0))
        messages = self.intake()
        self.assertEqual(len(messages), 3)
        self.assertEqual({m['role'] for m in messages}, {'user'})
        self.assertEqual({m['site'] for m in messages}, {'notion'})
        self.assertEqual({m['conversationId'] for m in messages}, {f'notion:{self.root}', f'notion:{sub}'})
        self.assertEqual(sorted(m['text'] for m in messages),
                         sorted(['# 결정\nMINE 우리는 SQLite를 쓴다.', 'MINE 금요일까지 공유한다.', 'MINE 하위 페이지의 결정']),
                         'a section of mine that follows one of theirs has no heading: the heading was not mine to carry')
        stored = self.db.read_bytes()
        for canary in (b'OTHER_AUTHOR_CANARY', b'RECORD_CANARY'):
            self.assertNotIn(canary, stored, 'not in the private database either')
        row = self.scope_row()
        self.assertEqual((row['last_error'], row['imported'], row['cursor']), (None, 3, '2026-11-11T09:00:00+00:00'))
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root), dict(documents=0, sent=0, skipped=0), 'nothing changed')
        # a page that gets edited is read again, and only the section that changed is new
        f.add_block(self.root, 'paragraph', 'MINE 새로 덧붙인 결정')
        f.pages[self.root]['last_edited_time'] = '2026-11-12T09:00:00.000Z'
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root), dict(documents=1, sent=1, skipped=1))
        self.assertEqual(len(self.intake()), 4)
        self.assertEqual(self.scope_row()['cursor'], '2026-11-12T09:00:00+00:00')
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root), dict(documents=0, sent=0, skipped=0))

    def test_without_the_author_choice_the_scope_fails_with_its_kind_and_a_next_step(self):
        self.save()
        self.scope()
        with self.quietly():
            result = base.run_scope(self.pipeline, 'notion', self.root)
        self.assertEqual(result, dict(documents=0, sent=0, skipped=0, error='author_unset'))
        self.assertEqual(self.scope_row()['last_error'], 'author_unset')
        self.assertEqual(self.provider.status(self.pipeline)['needs'], notion.NEEDS_USER)
        self.assertEqual((self.fake.requests, self.intake()), ([], []))

    def test_the_owner_checkbox_lets_the_document_owner_import_everything_unattributed(self):
        self.fake.add_block(self.root, 'paragraph', 'OWNER_TEXT', by=OTHER)
        self.save(owner=True)
        self.scope()
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root)['sent'], 1)
        self.assertEqual([m['text'] for m in self.intake()], ['OWNER_TEXT'])

    def test_a_page_the_integration_cannot_see_is_an_error_that_says_to_share_it(self):
        self.mine()
        missing = 'deadbeef-dead-beef-dead-beefdeadbeef'
        self.scope(missing)
        with self.quietly():
            result = base.run_scope(self.pipeline, 'notion', missing)
        self.assertEqual(result['error'], 'not_found 404')
        self.assertIn('공유', self.provider.status(self.pipeline)['needs'])

    def test_a_revoked_token_is_an_error_without_the_token(self):
        self.mine()
        self.scope()
        self.fake.token = REVOKED
        with self.quietly() as logs:
            result = base.run_scope(self.pipeline, 'notion', self.root)
        self.assertEqual(result['error'], 'unauthorized 401')
        self.assertEqual(self.scope_row()['last_error'], 'unauthorized 401')
        self.assertEqual(self.provider.status(self.pipeline)['needs'], notion.NEEDS_TOKEN_AGAIN)
        self.assertNotIn(TOKEN, ''.join(logs.output) + json.dumps(dispatch(self.pipeline, 'connectors.list', {})))

    def test_the_team_record_never_reaches_the_pipeline(self):
        record = self.fake.child_page(self.root, 'SyncUp 팀 기록 — 팀')
        self.fake.add_block(record, 'paragraph', 'RECORD_CANARY')
        self.fake.add_block(self.root, 'paragraph', 'MINE 본문')
        self.mine()
        self.scope()
        self.assertEqual(base.run_scope(self.pipeline, 'notion', self.root)['sent'], 1)
        self.assertNotIn(b'RECORD_CANARY', self.db.read_bytes())


class TokenStaysOnThePC(NotionFixture):
    """The token is typed into the local page, used by the connector, and is in its own file and nowhere else."""

    def setUp(self):
        super().setUp()
        self.srv = self.enterContext(server(Review, self.db))
        self.srv.pipeline, self.srv.team_client = self.pipeline, self.pipeline.client
        self.seen = []

    def record(self, text):
        self.seen.append(text if isinstance(text, str) else text.decode())
        return text

    def test_setup_page_sync_rpc_and_disconnect(self):
        self.fake.add_block(self.root, 'paragraph', 'MINE 본문')
        self.fake.add_block(self.root, 'paragraph', 'THEIRS 남의 본문', by=OTHER)
        html = self.record(get_page(self.srv, '/connectors')[1])
        for needle in ('노션', 'name="token"', 'name="pages"', 'name="owner"', 'action="/connectors/setup"', '연결 필요'):
            self.assertIn(needle, html)
        self.assertNotIn('name="user_id"', html, 'no token yet: no people to choose from')
        status, body = post(self.srv, '/connectors/setup', dict(site='notion', token=TOKEN, pages=self.root))
        self.record(body)
        self.assertEqual(status, 200)
        self.assertIn('프로젝트 노트', body.decode())
        self.assertEqual(self.settings()['token'], TOKEN)
        html = self.record(get_page(self.srv, '/connectors')[1])
        self.assertIn('연결됨', html)
        self.assertIn('프로젝트 노트', html)
        self.assertIn(f'<option value="{ME.replace("-", "")}">나 (me@example.invalid)</option>', html, 'the people list is on the page')
        self.assertIn('내 노션 사용자를 고르거나', html, 'the next step is on the page')
        status, body = post(self.srv, '/connectors/setup', dict(site='notion', users_shown='1', user_id=ME.replace('-', '')))
        self.record(body)
        self.assertEqual(status, 200)
        self.assertEqual(self.settings()['user_id'], ME)
        html = self.record(get_page(self.srv, '/connectors')[1])
        self.assertIn(f'<option value="{ME.replace("-", "")}" selected>', html, 'the chosen person stays chosen: the page blanks the dashed id')
        self.assertIn('통합 토큰 (저장되어 있습니다', html)
        self.assertNotIn(ME, html)
        status, body = post(self.srv, '/connectors/sync', dict(site='notion', scope_id=self.root))
        self.record(body)
        self.assertEqual((status, '새 글 1개' in body.decode()), (200, True))
        self.assertEqual([m['text'] for m in self.intake()], ['MINE 본문'])
        listed = dispatch(self.pipeline, 'connectors.list', {})['providers'][0]
        self.record(json.dumps(listed, ensure_ascii=False))
        self.assertEqual((listed['site'], listed['label'], listed['status']), ('notion', '노션', dict(connected=True, tokenSet=True, needs=None)))
        self.assertEqual([s['scopeId'] for s in listed['scopes']], [self.root])
        # Notion starts refusing the token, and its answers hold the token we sent
        self.fake.token = REVOKED
        with self.quietly() as logs:
            status, body = post(self.srv, '/connectors/sync', dict(site='notion'))
        self.record(body)
        self.assertIn('unauthorized 401', body.decode())
        self.record('\n'.join(logs.output))
        self.record(json.dumps(dispatch(self.pipeline, 'connectors.list', {}), ensure_ascii=False))
        self.record(get_page(self.srv, '/connectors')[1])
        self.record(get_page(self.srv, '/')[1])
        status, body = post(self.srv, '/connectors/setup', dict(site='notion', token='ntn_AnotherWrongToken0123456789'))
        self.record(body)
        self.assertEqual(status, 400)
        self.assertEqual(self.settings()['token'], TOKEN, 'a token that Notion refuses does not replace the saved one')
        self.assertEqual(post(self.srv, '/connectors/disconnect', dict(site='notion'))[0], 200)
        self.assertIsNone(self.settings())
        self.record(get_page(self.srv, '/connectors')[1])
        for text in self.seen:
            self.assertNotIn(TOKEN, text)
            self.assertNotIn(TOKEN[:20], text)
            self.assertNotIn('AnotherWrongToken', text)
        self.assertNotIn(TOKEN.encode(), self.db.read_bytes())
        self.assertNotIn(b'THEIRS', self.db.read_bytes())

    def test_the_form_refuses_a_bad_address_and_shows_why(self):
        status, body = post(self.srv, '/connectors/setup', dict(site='notion', token=TOKEN, pages='https://example.com/page'))
        self.assertEqual((status, '노션 페이지 주소' in body.decode()), (400, True))
        self.assertIsNone(self.settings())
        status, body = post(self.srv, '/connectors/setup', dict(site='notion', token=TOKEN, pages='deadbeef' * 4))
        self.assertEqual((status, '추가하지 못한 페이지' in body.decode()), (400, True))
        self.assertEqual(self.settings()['token'], TOKEN)
        self.assertNotIn(TOKEN, body.decode())


if __name__ == '__main__':
    unittest.main(verbosity=2)
