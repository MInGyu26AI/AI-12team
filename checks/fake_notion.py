"""A local stand-in for the Notion REST API (the block endpoints server/notion_page.py uses), for checks only.

It refuses what the real API refuses (developers.notion.com reference/request-limits and patch-block-children,
read 2026-11-14): a missing or old Notion-Version, a body over 500KB, more than 100 children in one append, children
nested deeper than one block's children (SyncUp's own limit, narrower than Notion's), more than 1000 block elements,
a rich text item over 2000 characters (counted as UTF-16 units), a rich text array over 100 items and the `after`
field the 2026-03-11 version removed.
"""
from contextlib import contextmanager
import http.server
import json
import threading
import urllib.parse
import uuid

from check_teams import running_server

VERSION = '2026-03-11'
EDITED = '2026-11-14T13:00:00.000Z'


class FakeNotion:
    def __init__(self, token):
        self.token, self.blocks, self.requests, self.lock = token, {}, [], threading.RLock()
        self.page = self.new_block('page', None, {})  # the page shared with the integration
        self.page_size = 100  # most a GET of children returns; smaller to check paging
        self.fail_next = None  # (method, path fragment, status): answered once instead of the real reply
        self.fail_from = None  # (method, n, status): that method's n-th request and every later one get `status`
        self.redirect_next = None  # (path fragment, location): answered once with a 302 to `location`
        self.rate_limited = 0  # this many next requests answer 429 rate_limited
        self.retry_after = '1'  # their Retry-After header (whole seconds)
        self.stored_text = lambda text: text  # how the page keeps a rich text item's text

    def new_block(self, kind, parent, body):
        identifier = str(uuid.uuid4())
        self.blocks[identifier] = dict(id=identifier, type=kind, body=body, parent=parent, children=[], in_trash=False)
        if parent:
            self.blocks[parent]['children'].append(identifier)
        return identifier

    def add_by_hand(self, kind, text=''):
        """A block a person put on the page; a child_page stands for a sub-page."""
        with self.lock:
            body = dict(title=text) if kind == 'child_page' else dict(rich_text=_rich(text))
            return self.new_block(kind, self.page, body)

    def live(self, block_id):
        return [c for c in self.blocks[block_id]['children'] if not self.blocks[c]['in_trash']]

    def outline(self, block_id=None, depth=0):
        """The page as lines: '  ' per level, the block type, then its text (✓ for a checked to-do)."""
        with self.lock:
            lines = []
            for child in self.live(block_id or self.page):
                block = self.blocks[child]
                text = block['body'].get('title') or ''.join(r['plain_text'] for r in block['body'].get('rich_text', []))
                check = ' ✓' if block['body'].get('checked') else ''
                lines.append(f"{'  ' * depth}{block['type']}: {text}{check}")
                lines += self.outline(child, depth + 1)
            return lines

    def top_ids(self):
        with self.lock:
            return self.live(self.page)

    def sent(self, method, fragment=''):
        with self.lock:
            return [r for r in self.requests if r[0] == method and fragment in r[1]]

    def answer(self, method, path, headers, raw):
        if self.redirect_next and self.redirect_next[0] in path:
            location, self.redirect_next = self.redirect_next[1], None
            return 302, {'location': location}, {}
        if headers.get('Notion-Version') != VERSION:
            return _error(400, 'missing_version')
        if headers.get('Authorization') != 'Bearer ' + self.token:
            return _error(401, 'unauthorized')
        if self.rate_limited:
            self.rate_limited -= 1
            status, reply, _ = _error(429, 'rate_limited')
            return status, reply, {'Retry-After': self.retry_after}
        if self.fail_next and method == self.fail_next[0] and self.fail_next[1] in path:
            status, self.fail_next = self.fail_next[2], None
            return _error(status, 'synthetic_failure')
        if self.fail_from and method == self.fail_from[0] and len(self.sent(method)) >= self.fail_from[1]:
            return _error(self.fail_from[2], 'synthetic_failure')
        if len(raw) > 500_000:
            return _error(400, 'validation_error')
        body = json.loads(raw) if raw else None
        url = urllib.parse.urlsplit(path)
        parts = url.path.split('/')[2:]  # after /v1
        if len(parts) < 2 or parts[0] != 'blocks' or parts[1] not in self.blocks or self.blocks[parts[1]]['in_trash']:
            return _error(404, 'object_not_found')
        if method == 'GET' and parts[2:] == ['children']:
            return self.list_children(parts[1], urllib.parse.parse_qs(url.query))
        if method == 'PATCH' and parts[2:] == ['children']:
            return self.append(parts[1], body)
        if method == 'DELETE' and len(parts) == 2:
            self.blocks[parts[1]]['in_trash'] = True
            return 200, self.block_object(parts[1]), {}
        return _error(400, 'invalid_request_url')

    def list_children(self, parent, query):
        size = min(int(query.get('page_size', ['100'])[0]), self.page_size)
        children = self.live(parent)
        start = children.index(query['start_cursor'][0]) if 'start_cursor' in query else 0
        shown = children[start:start + size]
        more = start + size < len(children)
        return 200, dict(object='list', results=[self.block_object(c) for c in shown], has_more=more,
                         next_cursor=children[start + size] if more else None, type='block', block={}), {}

    def append(self, parent, body):
        problem = _invalid(body)
        if problem:
            return _error(400, 'validation_error')
        children = self.live(parent)
        position = body.get('position') or dict(type='end')
        if position['type'] == 'start':
            at = 0
        elif position['type'] == 'end':
            at = len(children)
        elif position['type'] == 'after_block' and position['after_block']['id'] in children:
            at = children.index(position['after_block']['id']) + 1
        else:
            return _error(400, 'validation_error')
        created = [self.create(parent, block) for block in body['children']]
        order = self.blocks[parent]['children']
        for identifier in created:
            order.remove(identifier)
        anchor = order.index(children[at - 1]) + 1 if at else 0  # trashed children keep their places
        order[anchor:anchor] = created
        return 200, dict(object='list', results=[self.block_object(c) for c in created], has_more=False,
                         next_cursor=None, type='block', block={}), {}

    def create(self, parent, block):
        kind = block['type']
        body = {k: v for k, v in block[kind].items() if k != 'children'}
        body['rich_text'] = [dict(r, plain_text=self.stored_text(r['text']['content']), href=None)
                             for r in body.get('rich_text', [])]
        identifier = self.new_block(kind, parent, body)
        for child in block[kind].get('children', []):
            self.create(identifier, child)
        return identifier

    def block_object(self, identifier):
        block = self.blocks[identifier]
        return {'object': 'block', 'id': identifier, 'type': block['type'], 'has_children': bool(self.live(identifier)),
                'in_trash': block['in_trash'], 'created_time': EDITED, 'last_edited_time': EDITED,
                'parent': {'type': 'block_id', 'block_id': block['parent']}, block['type']: block['body']}


def _rich(text):
    return [dict(type='text', text=dict(content=text), plain_text=text, href=None)] if text else []


def _invalid(body):
    """Why Notion would refuse this append body (a short reason), or None."""
    if not isinstance(body, dict) or set(body) - {'children', 'position'}:
        return 'unknown field'
    blocks = body.get('children')
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= 100:
        return 'children count'
    elements = 0
    for block in blocks:
        kids = block[block['type']].get('children', [])
        elements += 1 + len(kids)
        if len(kids) > 100 or any(kid[kid['type']].get('children') for kid in kids):
            return 'nesting'
        for item in [block, *kids]:
            rich = item[item['type']].get('rich_text', [])
            if len(rich) > 100 or any(len(r['text']['content'].encode('utf-16-le')) > 4000 for r in rich):
                return 'rich text'
    return 'elements' if elements > 1000 else None


def _error(status, code):
    return status, dict(object='error', status=status, code=code, message='synthetic'), {}


def _reply(handler, status, reply, headers):
    data = json.dumps(reply).encode()
    handler.send_response(status)
    if 300 <= status < 400:
        handler.send_header('Location', reply['location'])
    for name, value in headers.items():
        handler.send_header(name, value)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


@contextmanager
def fake_notion(fake):
    """Serve `fake` on loopback; yields the API base URL (…/v1)."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_api(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            with fake.lock:
                fake.requests.append((self.command, self.path, raw.decode(), self.headers.get('Authorization')))
                status, reply, headers = fake.answer(self.command, self.path, self.headers, raw)
            _reply(self, status, reply, headers)

        do_GET = do_PATCH = do_DELETE = handle_api
    with running_server(Handler) as srv:
        yield f'http://127.0.0.1:{srv.server_port}/v1'
