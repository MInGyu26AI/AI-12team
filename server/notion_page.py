"""The Notion REST calls that keep one page's SyncUp blocks equal to a list of blocks (standard library only).

Only the API host gets the token: redirects are refused, since the API never sends one. Requests are spaced to the
average rate Notion allows an integration (about three a second), and a 429 waits as long as Retry-After says.
Limits and version, from developers.notion.com (read 2026-11-14): reference/versioning, request-limits,
status-codes, patch-block-children, get-block-children, delete-a-block.
"""
import hashlib
import http.client
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

NOTION_API = 'https://api.notion.com/v1'
NOTION_VERSION = '2026-03-11'  # appends take `position`; `after` is gone from this version
REQUEST_TIMEOUT_SECONDS = 15
REQUEST_INTERVAL_SECONDS = 1 / 3  # 180 requests a minute per integration outside Business and Enterprise plans
RATE_LIMIT_RETRIES = 4  # 429 rate_limited and 529 service_overload: wait Retry-After (whole seconds), then again
LONGEST_RETRY_AFTER_SECONDS = 60  # a longer wait fails this save; the next change tries again
SERVER_ERROR_RETRIES = 2  # 500/502/503/504 again only for GET and DELETE: a failed write may still have been saved
MAX_CHILDREN = 100  # blocks in one append
MAX_ELEMENTS = 1000  # block elements in one append, children included
MAX_PAYLOAD_BYTES = 400_000  # Notion takes 500KB; the rest is room for the envelope
MAX_TEXT = 2000  # characters in one rich text item (counted as UTF-16 units, the stricter reading)
MAX_RICH_TEXT = 100  # items in one rich text array
# The block types SyncUp writes. Only these are replaced; sub-pages, databases, files and the like stay on the page.
OWN_TYPES = frozenset({'callout', 'heading_2', 'heading_3', 'paragraph', 'bulleted_list_item', 'to_do'})

_turns = threading.Lock()  # one integration token, so one request pace for every save
_next_turn = 0.0  # monotonic time the next request may start


class _Refused(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # the 3xx comes back as an HTTPError and the request is never sent elsewhere


_opener = urllib.request.build_opener(_Refused)


class NotionError(Exception):
    """A Notion API failure at one step ('read', 'append' or 'delete'); `code` is the HTTP status when Notion answered."""

    def __init__(self, step, code=None):
        super().__init__(f'Notion {step} 실패')
        self.step, self.code = step, code


def call(target, method, path, body=None, step='read'):
    """One request to `{api}/{path}` with `target.token`, paced and retried as Notion asks; the JSON answer."""
    tries = dict(rate=0, server=0)
    while True:
        _take_turn()
        request = urllib.request.Request(
            f'{target.api}/{path}', method=method, data=None if body is None else _encode(body),
            headers={'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json',
                     'User-Agent': 'SyncUp-team-server'})
        request.add_unredirected_header('Authorization', 'Bearer ' + target.token)
        try:
            with _opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            wait = _retry_wait(error, method, tries)
            error.close()
            if wait is None:
                raise NotionError(step, error.code) from None
            _hold(wait)
        except (OSError, ValueError, http.client.HTTPException):  # no connection, timeout, broken reply or not JSON
            raise NotionError(step) from None


def _encode(value):
    """The JSON body as sent; also what the payload limit is measured on."""
    return json.dumps(value, ensure_ascii=False).encode()


def _retry_wait(error, method, tries):
    """Seconds to wait before trying `error`'s request again, or None when it is not worth another try."""
    if error.code in (429, 529):
        if _error_code(error) == 'public_api_request_blocked' or tries['rate'] >= RATE_LIMIT_RETRIES:
            return None
        try:
            seconds = float(error.headers.get('Retry-After') or 1)
        except ValueError:
            seconds = 1
        if not 0 <= seconds <= LONGEST_RETRY_AFTER_SECONDS:
            return None
        tries['rate'] += 1
        return seconds
    if error.code in (500, 502, 503, 504) and method in ('GET', 'DELETE') and tries['server'] < SERVER_ERROR_RETRIES:
        tries['server'] += 1
        return tries['server']
    return None


def _error_code(error):
    """Notion's error code (e.g. 'rate_limited') from the reply; never logged or returned."""
    try:
        return json.loads(error.read()).get('code')
    except (OSError, ValueError, AttributeError, http.client.HTTPException):
        return None


def _take_turn():
    global _next_turn
    with _turns:
        now = time.monotonic()
        start = max(now, _next_turn)
        _next_turn = start + REQUEST_INTERVAL_SECONDS
    time.sleep(start - now)


def _hold(seconds):
    """Rate limited: no request from any save starts before `seconds` from now."""
    global _next_turn
    with _turns:
        _next_turn = max(_next_turn, time.monotonic() + seconds)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]


def signature(block):
    """What reading the page shows of a block: its type, its own text (not its children's) and a to-do's check."""
    body = block.get(block.get('type')) or {}
    text = ''.join(item.get('plain_text', (item.get('text') or {}).get('content', '')) for item in body.get('rich_text') or [])
    return block.get('type'), text, body.get('checked')


def children(target, block_id):
    """The block's first-level children, every page of them."""
    found, cursor = [], None
    while True:
        query = dict(page_size=100, **({'start_cursor': cursor} if cursor else {}))
        page = call(target, 'GET', f'blocks/{block_id}/children?{urllib.parse.urlencode(query)}')
        found += page['results']
        cursor = page.get('next_cursor')
        if not (page.get('has_more') and cursor):
            return found


def save(target, blocks, known):
    """Make the page's SyncUp blocks equal to `blocks`, replacing only the top-level blocks that differ; True when
    anything was written.

    known: {block id: (fingerprint, signature as Notion shows it)} of the SyncUp blocks on the page, kept by the caller
    ({} after a start) and brought up to date here after every append and delete, so a save that stops halfway still
    leaves it right. A block it does not know (added or edited by hand, or added by a save whose reply was lost) goes;
    one it knows but cannot find comes back. Only a block's own text is compared, not its children's."""
    page = [b for b in children(target, target.page_id) if b.get('type') in OWN_TYPES and not b.get('in_trash')]
    ids, seen = [b['id'] for b in page], [signature(b) for b in page]
    marks, signs = [fingerprint(b) for b in blocks], [signature(b) for b in blocks]
    for gone in set(known) - set(ids):
        del known[gone]
    if not known and seen == signs:  # written before this start: the same header shows the same fingerprint
        known.update(zip(ids, zip(marks, seen)))
    old = [known[i][0] if known.get(i, (None, None))[1] == sign else None for i, sign in zip(ids, seen)]
    ops = SequenceMatcher(None, old, marks, autojunk=False).get_opcodes()
    doomed, after = [], None
    for op, i1, i2, j1, j2 in ops:
        if op == 'equal':
            after = ids[i2 - 1]
            continue
        doomed += ids[i1:i2]
        for mark, block in zip(marks[j1:j2], append(target, target.page_id, blocks[j1:j2], after)):
            known[block['id']] = (mark, signature(block))
            after = block['id']
    for block_id in doomed:  # after the new blocks are in, so the page is never empty in between
        delete(target, block_id)
        known.pop(block_id, None)
    return any(op != 'equal' for op, *_ in ops)


def append(target, parent, blocks, after=None):
    """Insert `blocks` right after the child `after` of `parent` (first when None). Yields the new blocks as Notion
    returns them, in order, one request's worth at a time."""
    for chunk in _chunks(blocks):
        position = dict(type='after_block', after_block=dict(id=after)) if after else dict(type='start')
        created = call(target, 'PATCH', f'blocks/{parent}/children', dict(children=chunk, position=position),
                       step='append').get('results') or []
        if len(created) != len(chunk) or not all(isinstance(b, dict) and b.get('id') for b in created):
            raise NotionError('append')
        yield from created
        after = created[-1]['id']


def delete(target, block_id):
    """Move one block (and what is in it) to the trash; one already gone is fine."""
    try:
        call(target, 'DELETE', f'blocks/{block_id}', step='delete')
    except NotionError as error:
        if error.code != 404:
            raise


def _chunks(blocks):
    """Groups of blocks within one append's limits. A block may hold up to MAX_CHILDREN children of its own,
    which hold none: deeper nesting would need the children's ids, which an append does not return."""
    chunk, elements, size = [], 0, 0
    for block in blocks:
        kids = block[block['type']].get('children') or []
        if block['type'] not in OWN_TYPES or len(kids) > MAX_CHILDREN or any(
                kid['type'] not in OWN_TYPES or kid[kid['type']].get('children') for kid in kids):
            raise ValueError('SyncUp이 쓰는 블록 모양이 아닙니다.')
        count, weight = 1 + len(kids), len(_encode(block))
        if chunk and (len(chunk) == MAX_CHILDREN or elements + count > MAX_ELEMENTS or size + weight > MAX_PAYLOAD_BYTES):
            yield chunk
            chunk, elements, size = [], 0, 0
        chunk.append(block)
        elements, size = elements + count, size + weight
    if chunk:
        yield chunk
