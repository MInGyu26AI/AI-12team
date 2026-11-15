"""Saving the team state to a Notion page, at the same moments as the GitHub save (repo_sync.py).

A team links its page from the web (link_request: POST /teams/{id}/notion, …/notion/verify, …/notion/unlink): any
active member gives the page (its id or address) and an internal integration's secret, with the page shared to that
integration. The server checks that the secret can write there and keeps the link in syncup.team_notion_links.
The server's environment can still link one team: SYNCUP_NOTION_TEAM (team id), SYNCUP_NOTION_PAGE (page id) and
SYNCUP_NOTION_TOKEN. A team's own web link wins over it. Notion is set apart from GitHub: either can be on alone.
The page shows what SYNCUP.md shows (ai/syncup_ai/team_state.py render_markdown) as Notion blocks. Only top-level
blocks that differ from the last save are replaced, and nothing is written when the page already shows the same.
The token is sent only to the Notion API (notion_page.py); it is never logged or returned to any client.
"""
import os
import re
import threading
import time
import urllib.parse
import uuid
import weakref
from dataclasses import dataclass, field

import repo_sync
from ai.syncup_ai.team_state import RESOLUTION_NAMES, by_whom, short_date
from diagnostics import failure
from notion_page import MAX_RICH_TEXT, MAX_TEXT, NOTION_API, NotionError, fingerprint, save, verify
from team_access import AccessError, authorized, team_lock

PAGE_ID = re.compile(r'[0-9a-fA-F]{32}')
SECRET = re.compile(r'[!-~]{20,500}')  # visible ASCII only: it goes into an HTTP header
ALERT_COLORS = {'충돌': 'red', '변경': 'blue'}  # the board's alert levels; anything else is 'needs a look' (yellow)


@dataclass(frozen=True)
class NotionTarget:
    team_id: uuid.UUID
    page_id: str
    token: str = field(repr=False)
    api: str = NOTION_API


def target_from_env(env=os.environ):
    """The linked page, or None when no Notion setting is given (then nothing is saved)."""
    team, page, token = (env.get(name, '').strip()
                         for name in ('SYNCUP_NOTION_TEAM', 'SYNCUP_NOTION_PAGE', 'SYNCUP_NOTION_TOKEN'))
    if not (team or page or token):
        return None
    if not (team and page and token):
        raise ValueError('SYNCUP_NOTION_TEAM·SYNCUP_NOTION_PAGE·SYNCUP_NOTION_TOKEN을 함께 설정하세요.')
    if not PAGE_ID.fullmatch(page.replace('-', '')):
        raise ValueError('SYNCUP_NOTION_PAGE는 페이지 ID(16진수 32자리, 하이픈은 있어도 됨)여야 합니다.')
    if not SECRET.fullmatch(token):
        raise ValueError('SYNCUP_NOTION_TOKEN은 노션 내부 통합의 시크릿이어야 합니다.')
    try:
        team_id = uuid.UUID(team)
    except ValueError:
        raise ValueError('SYNCUP_NOTION_TEAM은 팀 ID(uuid)여야 합니다.') from None
    return NotionTarget(team_id, str(uuid.UUID(page.replace('-', ''))), token)


# --- the page: SYNCUP.md's sections as blocks --------------------------------------------------------------------

def _pieces(content):
    """`content` cut into runs of at most MAX_TEXT UTF-16 units, never inside a character."""
    pieces, piece, units = [], '', 0
    for character in content:
        size = 2 if ord(character) > 0xFFFF else 1
        if units + size > MAX_TEXT:
            pieces.append(piece)
            piece, units = '', 0
        piece, units = piece + character, units + size
    return pieces + ([piece] if piece else [])


def _text(content, **style):
    """Rich text items for one run of text (bold, italic, strikethrough, code, color); long runs are split."""
    annotations = {name: value for name, value in style.items() if value}
    return [dict(type='text', text=dict(content=piece), **({'annotations': annotations} if annotations else {}))
            for piece in _pieces(content)]


def _block(kind, *runs, children=(), **extra):
    body = dict(rich_text=[item for run in runs for item in run][:MAX_RICH_TEXT], **extra)
    if children:
        body['children'] = list(children)
    return {'type': kind, kind: body}


def _heading(title, level=2):
    return _block(f'heading_{level}', _text(title))


def _bullet(*runs, children=()):
    return _block('bulleted_list_item', *runs, children=children)


def _note(content):
    return _block('paragraph', _text(content, color='gray'))


def _header(state, mark):
    team, s = state['team'], state['summary']
    counts = (f"기준 시각 {state['updated_at'] or '-'} · 결정 {s['decisions']} · 열린 충돌 {s['open_conflicts']}"
              f" · 할 일 {s['todos']} (완료 {s['todos_done']})" + (f" · 레포 {team['repo']}" if team.get('repo') else ''))
    title = 'SyncUp 팀 기록' + (f" — {team['name']}" if team.get('name') else '')
    runs = [_text(title + '\n', bold=True),
            _text('팀이 승인한 결정을 SyncUp이 자동으로 모은 페이지입니다. 직접 고치지 마세요 (다음 변경 때 덮어씁니다).\n'),
            _text(counts, color='gray')]
    if mark:
        runs += [_text(' · 지문 ', color='gray'), _text(mark, code=True, color='gray')]
    return _block('callout', *runs, icon=dict(type='emoji', emoji='🔄'), color='gray_background')


def _body(state):
    team, blocks = state['team'], []
    if team.get('goal') or team.get('scope') or team.get('rules'):
        blocks.append(_heading('팀 기준'))
        blocks += [_bullet(_text(f'{label}: ', bold=True), _text(value)) for label, value in
                   [('목표', team.get('goal')), ('범위', team.get('scope'))] + [('규칙', r) for r in team.get('rules') or []]
                   if value]

    if state['open_conflicts']:
        blocks.append(_heading('⚠️ 확인이 필요한 결정'))
        for c in state['open_conflicts']:
            judgement = c['judgement'] or '충돌'
            reason = [_bullet(_text(f"이유: {c['reason']}"))] if c.get('reason') else []
            blocks.append(_bullet(
                _text(c['topic_key'] or '결정', bold=True), _text(' '),
                _text(f'[{judgement}]', bold=True, color=ALERT_COLORS.get(judgement, 'yellow')),
                _text(' (팀 논의 중)' if c['status'] == 'discuss' else ''),
                _text(f": 기존 \"{c['existing']['content']}\"({c['existing']['owner'] or '?'}) ↔ "
                      f"새 \"{c['new']['content']}\"({c['new']['owner'] or '?'})"), children=reason))

    blocks.append(_heading('현재 결정'))
    subtopic = None
    for topic in state['decisions']:
        if not topic['current']:
            continue
        if topic['subtopic'] != subtopic:
            subtopic = topic['subtopic']
            blocks.append(_heading(subtopic, level=3))
        history = [_bullet(_text(old['content'] or '', strikethrough=True),
                           _text(f"{by_whom(old)} ({'바뀜' if old['state'] == 'superseded' else '채택 안 됨'})"))
                   for old in topic['history'][:2]]
        for n, d in enumerate(topic['current'], 1):  # like SYNCUP.md: earlier decisions once, after the last current
            below = [_bullet(_text(f"이유: {d['reason']}"))] if d.get('reason') else []
            below += history if n == len(topic['current']) else []
            blocks.append(_bullet(_text(topic['topic_key'], bold=True), _text(f": {d['content']}{by_whom(d)}"),
                                  _text(' (검토 중)' if d['state'] == 'review' else '', italic=True), children=below))
    if subtopic is None:
        blocks.append(_note('(아직 승인된 결정이 없습니다)'))

    blocks.append(_heading('할 일'))
    if not state['todos']:
        blocks.append(_note('(아직 승인된 할 일이 없습니다)'))
    for t in [t for t in state['todos'] if not t['done']] + [t for t in state['todos'] if t['done']]:
        owner = f" — {t['owner']}" if t.get('owner') else ''
        due = f" · {short_date(t['due'])}까지" if t.get('due') else ''
        blocks.append(_block('to_do', _text(t['id'], code=True), _text(f" {t['content']}{owner}{due}"), checked=t['done']))

    if state['research']:
        blocks.append(_heading('조사한 내용'))
        blocks += [_bullet(_text(f"{r['content']}" + (f" ({r['topic_key']})" if r.get('topic_key') else '')))
                   for r in state['research']]

    if state['resolved_conflicts']:
        resolved = [_bullet(_text(c['topic_key'] or '결정', bold=True),
                            _text(f": {RESOLUTION_NAMES.get(c['resolution'], c['resolution'])}"
                                  + (f" — {c['note']}" if c.get('note') else '')))
                    for c in reversed(state['resolved_conflicts'])]
        blocks.append(_block('heading_2', _text('최근 해결한 충돌'), is_toggleable=True, children=resolved))
    return blocks


def page_blocks(state):
    """The page for `state`: a header callout showing a fingerprint of all of it, then SYNCUP.md's sections."""
    body = _body(state)
    return [_header(state, fingerprint([_header(state, None), body])), *body]


# --- when: the GitHub save's moments, with its own queue and status ----------------------------------------------

@dataclass
class _Job:
    token: str = field(repr=False)
    first: float = 0  # when the first change of this batch came (monotonic)
    due: float = 0
    wake: threading.Event = field(default_factory=threading.Event)


@dataclass
class _Saves:
    """One server's Notion saves by team."""
    waiting: dict = field(default_factory=dict)  # team -> the _Job waiting for changes to settle
    running: dict = field(default_factory=dict)  # team -> number of saves under way
    known: dict = field(default_factory=dict)  # team -> the SyncUp blocks on its page (notion_page.save keeps it)
    status: dict = field(default_factory=dict)  # team -> the latest outcome, shown by GET …/notion


_servers = weakref.WeakKeyDictionary()  # server -> _Saves; a stopped server's entry goes with it
_lock = threading.Lock()  # guards every _Saves
_saving = threading.Lock()  # one Notion save at a time; GitHub saves run apart from these


def _saves(server):
    """The server's _Saves; the caller holds _lock."""
    if server not in _servers:
        _servers[server] = _Saves()
    return _servers[server]


def linked(server, team_id):
    """The page linked to this team (an id as uuid or text), or None. The team's web link comes first, then the
    server's environment link."""
    link = _cached_link(server, team_id)
    if link is not None and link.target is not None:
        return link.target
    target = getattr(server, 'notion_target', None)
    return target if target is not None and str(target.team_id) == str(team_id) else None


def first_check_due(server, team_id):
    """True until the linked team's first save after a start has begun (it also checks the connection)."""
    target = linked(server, team_id)
    if target is None:
        return False
    with _lock:
        saves = _saves(server)
        return not any(target.team_id in table for table in (saves.status, saves.waiting, saves.running))


def schedule_save(server, token, team_id, delay=None):
    """Save the linked team's page once no change has come for `delay` seconds (default: the GitHub save's),
    but no later than the GitHub save's longest wait after the batch's first change. Other teams are ignored."""
    target = linked(server, team_id)
    if target is None or server.checks_stop.is_set():
        return
    now = time.monotonic()
    delay = repo_sync.SAVE_DELAY_SECONDS if delay is None else delay
    with _lock:
        saves = _saves(server)
        job = saves.waiting.get(target.team_id)
        start = job is None
        if start:
            job = saves.waiting[target.team_id] = _Job(token, first=now)
        job.token = token  # the latest member's token reads the board
        job.due = min(now + delay, job.first + repo_sync.SAVE_MAX_WAIT_SECONDS)
        job.wake.set()
    if start:
        threading.Thread(target=_wait_then_save, args=(server, target, job), daemon=True).start()


def _wait_then_save(server, target, job):
    """Wait for the batch to settle, then save to the page linked at that moment (the team may have linked another
    one meanwhile, or unlinked)."""
    team_id = target.team_id
    while True:
        with _lock:
            wait = job.due - time.monotonic()
            if wait <= 0:
                saves = _saves(server)
                saves.waiting.pop(team_id, None)  # changes from now on wait for the next save
                saves.running[team_id] = saves.running.get(team_id, 0) + 1
                break
            job.wake.clear()
        job.wake.wait(wait)
    try:
        current = linked(server, team_id)
        if current is not None and not server.checks_stop.is_set():
            _save_and_record(server, current, job)
    finally:
        with _lock:
            running = _saves(server).running
            running[team_id] -= 1
            if not running[team_id]:
                del running[team_id]


def _save_and_record(server, target, job):
    """Rebuild and save; the outcome goes to GET …/notion, a failure also to the diagnostic log (step and kind only)."""
    with _saving:
        with _lock:
            saves = _saves(server)
            known = saves.known.setdefault(target.team_id, {})  # only saves, one at a time, use it
            saved_at = (saves.status.get(target.team_id) or {}).get('savedAt')
        try:
            with authorized(server.dsn, job.token, target.team_id) as (c, _user):
                repo = repo_sync.linked(server, target.team_id)
                state = repo_sync.team_state(c, target.team_id, repo and repo.repo)
            wrote = save(target, page_blocks(state), known)
            saved_at = time.time() if wrote else saved_at
            result = dict(state='saved' if wrote else 'unchanged', savedAt=saved_at)
        except Exception as error:  # a failed save never affects the team API; the next change tries again
            failure('notion_' + (error.step if isinstance(error, NotionError) else 'save'), error, target.team_id)
            result = dict(state='failed', savedAt=saved_at,
                          httpStatus=error.code if isinstance(error, NotionError) else None)
        with _lock:
            _saves(server).status[target.team_id] = dict(result, checkedAt=time.time())


def notion_status(server, team_id):
    """What GET …/notion shows about the linked page; {'linked': False} for every other team.

    source is 'team' for the team's web link and 'env' for the server's environment link. tokenSet only says that a
    token is kept; the token itself is never part of any answer."""
    target = linked(server, team_id)
    if target is None:
        return dict(linked=False)
    link = _cached_link(server, team_id)
    if link is not None and link.target == target:
        about = dict(source='team', **link.meta)
    else:
        about = dict(source='env', title='', linkedBy=None, linkedByName=None, linkedAt=None)
    with _lock:
        saves = _saves(server)
        busy = target.team_id in saves.waiting or target.team_id in saves.running
        status = dict(saves.status.get(target.team_id) or dict(state='unknown'), pending=busy)
    return dict(linked=True, page=target.page_id, tokenSet=True, **about, **status)


# --- a team's own link from the web (syncup.team_notion_links, team_upgrades.sql) ---------------------------------

LINK_CACHE_SECONDS = 60  # another server instance's link change is seen within this time
# POST /teams/{id}/notion<tail>: the action and the fields its JSON body may have.
LINK_ACTIONS = {(): ('link', ('page', 'token')), ('verify',): ('verify', ('page', 'token')), ('unlink',): ('unlink', ())}
PAGE_TEXT = re.compile(r'[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
PAGE_IN_ADDRESS = re.compile(r'(?:^|-)([0-9a-fA-F]{32})$')  # …/Title-<id> or …/<id>, as Notion's share links end
NOTION_HOSTS = ('notion.so', 'notion.site', 'notion.com')


@dataclass(frozen=True)
class _Link:
    """A team's web link as last read from the database; target None when it has none."""
    target: NotionTarget | None
    meta: dict
    loaded: float


_links = weakref.WeakKeyDictionary()  # server -> {team id text: _Link}; guarded by _lock


def _cached_link(server, team_id):
    if server is None:
        return None
    with _lock:
        return _links.get(server, {}).get(str(team_id))


def load_link(c, server, team_id):
    """Read the team's web link inside the request's transaction when it is not known or older than
    LINK_CACHE_SECONDS. Saves and status reads, which have no transaction, use what this keeps."""
    link = _cached_link(server, team_id)
    if server is not None and (link is None or time.monotonic() - link.loaded >= LINK_CACHE_SECONDS):
        _remember(server, team_id, read_link(c, team_id))


def _remember(server, team_id, row):
    """Keep the team's link (a read_link row, or None). A changed link forgets the last save's outcome and what it
    knew of the page, so the status reads 'unknown' until the first save to the new page."""
    target = None if row is None else NotionTarget(uuid.UUID(str(team_id)), row['page'], row['token'],
                                                   api=getattr(server, 'notion_api', NOTION_API))
    meta = {} if row is None else {k: row[k] for k in ('title', 'linkedBy', 'linkedByName', 'linkedAt')}
    with _lock:
        links = _links.setdefault(server, {})
        before = links.get(str(team_id))
        links[str(team_id)] = _Link(target, meta, time.monotonic())
        if before is None or before.target != target:
            saves = _saves(server)
            saves.status.pop(uuid.UUID(str(team_id)), None)
            saves.known.pop(uuid.UUID(str(team_id)), None)


def read_link(c, team_id):
    """The team's active link as {page, token, title, linkedBy, linkedByName, linkedAt}, or None."""
    row = c.execute('''SELECT page_id,token,title,actor,actor_name,at FROM syncup.team_notion_links
        WHERE team_id=%s AND active''', (team_id,)).fetchone()
    if not row:
        return None
    return dict(page=str(row['page_id']), token=row['token'], title=row['title'], linkedBy=str(row['actor']),
                linkedByName=row['actor_name'], linkedAt=row['at'].isoformat())


def _save_link(c, team_id, user_id, page, token, title):
    """Link (or relink) the team; the caller holds the team write lock and has checked the page."""
    name = c.execute('SELECT name FROM syncup.users').fetchone()['name']  # own row only (RLS)
    c.execute('''INSERT INTO syncup.team_notion_links(team_id,page_id,token,title,active,actor,actor_name)
        VALUES(%s,%s,%s,%s,true,%s,%s)
        ON CONFLICT(team_id) DO UPDATE SET page_id=excluded.page_id,token=excluded.token,title=excluded.title,
            active=true,actor=excluded.actor,actor_name=excluded.actor_name,at=clock_timestamp()''',
        (team_id, page, token, title, user_id, name[:200]))
    return read_link(c, team_id)


def _clear_link(c, team_id, user_id):
    """Unlink the team and drop its token; the caller holds the team write lock."""
    name = c.execute('SELECT name FROM syncup.users').fetchone()['name']
    c.execute('''UPDATE syncup.team_notion_links SET active=false,token='',actor=%s,actor_name=%s,at=clock_timestamp()
        WHERE team_id=%s AND active''', (user_id, name[:200], team_id))


def link_request(server, token, team_id, tail, data):
    """POST /teams/{id}/notion (link), …/notion/verify (check only) and …/notion/unlink, for any active member.

    Notion is called between two database transactions, never inside one. A refusal answers HTTP 200 with
    {ok: False, reason}, because the collector turns every 4xx into a 503 and the web could not say why.
    reason: bad-format, token-needed and notion_page.verify's (bad-token, not-found, not-a-page, no-write,
    rate-limited, unreachable). A new link saves the page once at once."""
    action, fields = LINK_ACTIONS.get(tuple(tail), (None, ()))
    if action is None:
        raise AccessError(404)
    if not isinstance(data, dict) or set(data) - set(fields):
        raise ValueError('노션 연결 필드 오류')
    answer = dict(team_id=str(team_id))
    if action == 'unlink':
        with authorized(server.dsn, token, team_id) as (c, user_id):
            team_lock(c, team_id)
            _clear_link(c, team_id, user_id)
        _remember(server, team_id, None)
        return dict(answer, ok=True, notion=notion_status(server, team_id))
    with authorized(server.dsn, token, team_id) as (c, _user):
        stored = read_link(c, team_id)
    wanted = _link_input(data, stored)
    if isinstance(wanted, str):
        return dict(answer, ok=False, reason=wanted)
    page, secret = wanted
    reason, title = verify(NotionTarget(uuid.UUID(str(team_id)), page, secret,
                                        api=getattr(server, 'notion_api', NOTION_API)))
    answer['check'] = dict(page=page, title=title, canWrite=reason is None)
    if reason is not None or action == 'verify':
        return dict(answer, ok=reason is None, **({'reason': reason} if reason else {}))
    with authorized(server.dsn, token, team_id) as (c, user_id):
        team_lock(c, team_id)
        row = _save_link(c, team_id, user_id, page, secret, title)
    _remember(server, team_id, row)
    schedule_save(server, token, team_id, delay=0)
    return dict(answer, ok=True, notion=notion_status(server, team_id))


def _link_input(data, stored):
    """(page id, token) from a link or verify body, or the refusal reason. A missing token reuses the stored one
    only for the same page, so nobody can point the team's token at another page."""
    page, secret = data.get('page', ''), data.get('token')
    if not isinstance(page, str) or not (secret is None or isinstance(secret, str)):
        raise ValueError('노션 연결 필드 형식 오류')
    page = page_from(page)
    if page is None:
        return 'bad-format'
    secret = (secret or '').strip()
    if not secret:
        if stored is None or stored['page'] != page:
            return 'token-needed'
        secret = stored['token']
    elif not SECRET.fullmatch(secret):
        return 'bad-format'
    return page, secret


def page_from(text):
    """The page id (uuid text) in a page id or a Notion page address (notion.so, notion.site), or None.
    Only the id is kept: requests always go to the Notion API host, never to the address given."""
    text = text.strip()
    if '://' in text:
        try:
            address = urllib.parse.urlsplit(text)
            host = (address.hostname or '').lower()
        except ValueError:  # e.g. a broken [IPv6] host
            return None
        if address.scheme != 'https' or not any(host == name or host.endswith('.' + name) for name in NOTION_HOSTS):
            return None
        found = PAGE_IN_ADDRESS.search(address.path.rstrip('/').rsplit('/', 1)[-1])
        text = found.group(1) if found else ''
    if not PAGE_TEXT.fullmatch(text):
        return None
    return str(uuid.UUID(text.replace('-', '')))
