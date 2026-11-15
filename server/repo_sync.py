"""Saving the team state files (SYNCUP.md, syncup.json) to the linked GitHub repository.

A team links its repository from the web (link_request: POST /teams/{id}/repo, …/repo/verify, …/repo/unlink): any
active member gives owner/name, the branch and a fine-grained token for that repository only (Contents: read and
write). The server checks that the token can commit there and stores the link in syncup.team_repo_links.
The server's environment can still link one team: SYNCUP_GITHUB_TEAM (team id), SYNCUP_GITHUB_REPO (owner/name),
SYNCUP_GITHUB_BRANCH (default main) and SYNCUP_GITHUB_TOKEN. A team's own web link wins over it.
After a team change the files are rebuilt from the database. Changes less than SAVE_DELAY_SECONDS apart
go into one commit, and nothing is committed when the branch already holds the same files.
The token is sent only to the GitHub API (github_repo.py); it is never logged or returned to any client.
"""
import os
import re
import threading
import time
import uuid
import weakref
from dataclasses import dataclass, field

from ai.syncup_ai.team_state import build_state, dumps, render_markdown
from diagnostics import failure
from github_repo import GitHubError, last_commit, save, verify
from team_access import AccessError, authorized, team_lock
from team_board import board, conflicts, done_todos
from team_settings import clear_repo_link, read_repo_link, save_repo_link, state_team

GITHUB_API = 'https://api.github.com'
FILES = ('SYNCUP.md', 'syncup.json')
SAVE_DELAY_SECONDS = 10  # quiet time after the last change, so a burst of approvals becomes one commit
SAVE_MAX_WAIT_SECONDS = 60  # while changes keep coming, still save at least this often
REPO_NAME = re.compile(r'[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}')
# Names git accepts for a branch: no empty or dot-led part, no '..' and no '.lock' ending.
BRANCH_NAME = re.compile(r'(?![./])(?!.*(?:\.\.|//|/\.|/$|\.lock$))[A-Za-z0-9._/-]{1,200}')
TOKEN_TEXT = re.compile(r'[\x21-\x7e]{20,255}')  # any GitHub token: printable ASCII without spaces
LINK_CACHE_SECONDS = 60  # another server instance's link change is seen within this time
# POST /teams/{id}/repo<tail>: the action and the fields its JSON body may have.
LINK_ACTIONS = {(): ('link', ('repo', 'branch', 'token', 'acceptPublic')),
                ('verify',): ('verify', ('repo', 'branch', 'token')),
                ('unlink',): ('unlink', ())}


@dataclass(frozen=True)
class RepoTarget:
    team_id: uuid.UUID
    repo: str
    branch: str
    token: str = field(repr=False)
    api: str = GITHUB_API


def target_from_env(env=os.environ):
    """The linked repository, or None when no GitHub setting is given (then nothing is saved)."""
    team, repo, token = (env.get(name, '').strip()
                         for name in ('SYNCUP_GITHUB_TEAM', 'SYNCUP_GITHUB_REPO', 'SYNCUP_GITHUB_TOKEN'))
    if not (team or repo or token):
        return None
    if not (team and repo and token):
        raise ValueError('SYNCUP_GITHUB_TEAM·SYNCUP_GITHUB_REPO·SYNCUP_GITHUB_TOKEN을 함께 설정하세요.')
    branch = env.get('SYNCUP_GITHUB_BRANCH', '').strip() or 'main'
    if not REPO_NAME.fullmatch(repo) or not BRANCH_NAME.fullmatch(branch):
        raise ValueError('SYNCUP_GITHUB_REPO는 owner/name, SYNCUP_GITHUB_BRANCH는 브랜치 이름이어야 합니다.')
    try:
        team_id = uuid.UUID(team)
    except ValueError:
        raise ValueError('SYNCUP_GITHUB_TEAM은 팀 ID(uuid)여야 합니다.') from None
    return RepoTarget(team_id, repo, branch, token)


def state_files(c, target):
    """(syncup.json content, {file name: text}) for the linked team, read under the caller's row access."""
    team_id = target.team_id
    team = c.execute('SELECT name FROM syncup.teams WHERE id=%s', (team_id,)).fetchone()
    changed = c.execute('''SELECT greatest((SELECT max(at) FROM syncup.todo_states WHERE team_id=%s),
        (SELECT max(at) FROM syncup.conflict_events WHERE team_id=%s),
        (SELECT at FROM syncup.team_settings WHERE team_id=%s)) AS at''', (team_id, team_id, team_id)).fetchone()['at']
    state = build_state(board(c, team_id, history=True), conflicts(c, team_id, history=True), done_todos(c, team_id),
                        team=dict(name=team and team['name'], repo=target.repo, **state_team(c, team_id)),
                        changed_at=changed.timestamp() if changed else None)
    return state, {'SYNCUP.md': render_markdown(state), 'syncup.json': dumps(state)}


def describe_changes(old, new):
    """Readable changes from the previous syncup.json to the new one, decisions first."""
    old_current = {d['card_id'] for t in old.get('decisions', []) for d in t['current']}
    old_topics = {t['topic_key'] for t in old.get('decisions', []) if t['current']}
    changes = [f"{t['topic_key']} 결정 {'변경' if t['topic_key'] in old_topics else '추가'}"
               for t in new['decisions'] if any(d['card_id'] not in old_current for d in t['current'])]
    old_open = {c['id'] for c in old.get('open_conflicts', [])}
    changes += [f"{c['topic_key'] or '결정'} 충돌 확인 필요" for c in new['open_conflicts'] if c['id'] not in old_open]
    old_resolved = {c['id'] for c in old.get('resolved_conflicts', [])}
    changes += [f"{c['topic_key'] or '결정'} 충돌 해결" for c in new['resolved_conflicts'] if c['id'] not in old_resolved]
    old_todos = {t['id']: t['done'] for t in old.get('todos', [])}
    changes += [f"{t['id']} 할 일 추가" for t in new['todos'] if t['id'] not in old_todos]
    changes += [f"{t['id']} {'완료' if t['done'] else '다시 열림'}" for t in new['todos']
                if t['id'] in old_todos and old_todos[t['id']] != t['done']]
    old_research = {r['card_id'] for r in old.get('research', [])}
    changes += [f"{r['topic_key'] or '조사'} 조사 추가" for r in new['research'] if r['card_id'] not in old_research]
    return changes


def commit_message(old, new, people=None):
    """'SyncUp: MVP 범위 결정 변경 외 1건 (김단비 승인, 이서준)': the first change, how many more, and who made them.

    people: {name: True when that member approved a card in this batch}."""
    try:
        changes = describe_changes(old, new)
    except (KeyError, TypeError, AttributeError):  # the previous file was edited by hand
        changes = []
    summary = changes[0] + (f' 외 {len(changes) - 1}건' if len(changes) > 1 else '') if changes else '팀 기록 갱신'
    who = ', '.join(f'{name} 승인' if approved else name for name, approved in (people or {}).items())
    return f'SyncUp: {summary}' + (f' ({who})' if who else '')


@dataclass
class _Job:
    token: str = field(repr=False)
    first: float = 0  # when the first change of this batch came (monotonic)
    due: float = 0
    people: dict = field(default_factory=dict)  # name -> approved a card
    wake: threading.Event = field(default_factory=threading.Event)


@dataclass
class _Saves:
    """One server's saves by team."""
    waiting: dict = field(default_factory=dict)  # team -> the _Job waiting for changes to settle
    running: dict = field(default_factory=dict)  # team -> number of saves under way
    unsaved: dict = field(default_factory=dict)  # team -> people of failed saves, named in the next commit
    status: dict = field(default_factory=dict)  # team -> the latest outcome, shown by GET …/repo


_servers = weakref.WeakKeyDictionary()  # server -> _Saves; a stopped server's entry goes with it
_lock = threading.Lock()  # guards every _Saves
_saving = threading.Lock()  # one save at a time, so commits and their outcomes land in order


def _saves(server):
    """The server's _Saves; the caller holds _lock."""
    if server not in _servers:
        _servers[server] = _Saves()
    return _servers[server]


def _credit(people, more):
    for name, approved in more.items():
        people[name] = people.get(name, False) or approved


@dataclass(frozen=True)
class _Link:
    """A team's web link as last read from the database; target None when it has none."""
    target: RepoTarget | None
    meta: dict
    loaded: float


_links = weakref.WeakKeyDictionary()  # server -> {team id: _Link}; guarded by _lock


def linked(server, team_id):
    """The repository linked to this team (an id as uuid or text), or None. The team's web link comes first,
    then the server's environment link."""
    link = _cached_link(server, team_id)
    if link is not None and link.target is not None:
        return link.target
    target = getattr(server, 'repo_target', None)
    return target if target is not None and str(target.team_id) == str(team_id) else None


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
        _remember(server, team_id, read_repo_link(c, team_id))


def _remember(server, team_id, row):
    """Keep the team's link (row from team_settings.read_repo_link, or None); a changed link forgets the last
    save outcome, so the status reads 'unknown' until the next save to the new repository."""
    target = None if row is None else RepoTarget(uuid.UUID(str(team_id)), row['repo'], row['branch'], row['token'],
                                                 api=getattr(server, 'github_api', GITHUB_API))
    meta = {} if row is None else {k: row[k] for k in ('private', 'linkedBy', 'linkedByName', 'linkedAt')}
    with _lock:
        links = _links.setdefault(server, {})
        before = links.get(str(team_id))
        links[str(team_id)] = _Link(target, meta, time.monotonic())
        if before is None or before.target != target:
            _saves(server).status.pop(uuid.UUID(str(team_id)), None)


def first_check_due(server, team_id):
    """True until the linked team's first save after a start has begun (it also checks the connection)."""
    target = linked(server, team_id)
    if target is None:
        return False
    with _lock:
        saves = _saves(server)
        return not any(target.team_id in table for table in (saves.status, saves.waiting, saves.running))


def schedule_save(server, token, team_id, actor=None, approved=False, delay=None):
    """Save the linked team's files once no change has come for `delay` seconds (default SAVE_DELAY_SECONDS),
    but no later than SAVE_MAX_WAIT_SECONDS after the batch's first change. Other teams are ignored."""
    target = linked(server, team_id)
    if target is None or server.checks_stop.is_set():
        return
    now, delay = time.monotonic(), SAVE_DELAY_SECONDS if delay is None else delay
    with _lock:
        saves = _saves(server)
        job = saves.waiting.get(target.team_id)
        start = job is None
        if start:
            job = saves.waiting[target.team_id] = _Job(token, first=now)
            _credit(job.people, saves.unsaved.pop(target.team_id, {}))
        job.token = token  # the latest member's token reads the board
        job.due = min(now + delay, job.first + SAVE_MAX_WAIT_SECONDS)
        if actor:
            _credit(job.people, {actor: approved})
        job.wake.set()
    if start:
        threading.Thread(target=_wait_then_save, args=(server, target, job), daemon=True).start()


def _wait_then_save(server, target, job):
    """Wait for the batch to settle, then save to the repository linked at that moment (a team may have linked
    another one meanwhile, or unlinked)."""
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
    """Rebuild and save; the outcome goes to GET …/repo, a failure also to the diagnostic log (kind only)."""
    with _saving:
        with _lock:
            known = (_saves(server).status.get(target.team_id) or {}).get('commit')
        latest = {}

        def build():
            with authorized(server.dsn, job.token, target.team_id) as (c, _user):
                latest['state'], files = state_files(c, target)
            return files
        try:
            commit = save(target, build, lambda previous: commit_message(previous, latest['state'], job.people))
            if commit:
                result = dict(state='saved', commit=dict(sha=commit['sha'], url=commit.get('html_url'),
                                                         at=(commit.get('committer') or {}).get('date')))
            else:
                result = dict(state='unchanged', commit=known or last_commit(target, FILES[0]))
        except Exception as error:  # a failed save never affects the team API; the next change tries again
            failure('repo_save', error, target.team_id)
            result = dict(state='failed', commit=known,
                          httpStatus=error.code if isinstance(error, GitHubError) else None)
        with _lock:
            saves = _saves(server)
            if result['state'] == 'failed':
                waiting = saves.waiting.get(target.team_id)
                _credit(waiting.people if waiting else saves.unsaved.setdefault(target.team_id, {}), job.people)
            saves.status[target.team_id] = dict(result, checkedAt=time.time())


def repo_status(server, team_id):
    """What the web shows about the linked repository; {'linked': False} for every other team.

    source is 'team' for the team's web link and 'env' for the server's environment link. tokenSet only says
    that a token is stored; the token itself is never part of any answer."""
    target = linked(server, team_id)
    if target is None:
        return dict(linked=False)
    link = _cached_link(server, team_id)
    if link is not None and link.target == target:
        about = dict(source='team', **link.meta)
    else:
        about = dict(source='env', private=None, linkedBy=None, linkedByName=None, linkedAt=None)
    with _lock:
        saves = _saves(server)
        busy = target.team_id in saves.waiting or target.team_id in saves.running
        status = dict(saves.status.get(target.team_id) or dict(state='unknown'), pending=busy)
    return dict(linked=True, repo=target.repo, branch=target.branch, files=list(FILES), tokenSet=True,
                **about, **status)


def link_request(server, token, team_id, tail, data):
    """POST /teams/{id}/repo (link), …/repo/verify (check only) and …/repo/unlink, for any active member.

    GitHub is called between two database transactions, never inside one. A refusal answers HTTP 200 with
    {ok: False, reason}, because the collector turns every 4xx into a 503 and the web could not say why.
    reason: bad-format, token-needed, bad-token, not-found, no-branch, no-write, rate-limited, unreachable,
    public-needs-consent. A public repository is linked only with acceptPublic true; until then the answer
    points to the Notion page instead (alternative 'notion')."""
    action, fields = LINK_ACTIONS.get(tuple(tail), (None, ()))
    if action is None:
        raise AccessError(404)
    if not isinstance(data, dict) or set(data) - set(fields):
        raise ValueError('레포 연결 필드 오류')
    answer = dict(team_id=str(team_id))
    if action == 'unlink':
        with authorized(server.dsn, token, team_id) as (c, user_id):
            team_lock(c, team_id)
            clear_repo_link(c, team_id, user_id)
        _remember(server, team_id, None)
        return dict(answer, ok=True, repo=repo_status(server, team_id))
    with authorized(server.dsn, token, team_id) as (c, _user):
        stored = read_repo_link(c, team_id)
    wanted = _link_input(data, stored)
    if isinstance(wanted, str):
        return dict(answer, ok=False, reason=wanted)
    repo, branch, secret = wanted
    reason, private = verify(RepoTarget(uuid.UUID(str(team_id)), repo, branch, secret,
                                        api=getattr(server, 'github_api', GITHUB_API)))
    answer['check'] = dict(repo=repo, branch=branch, private=private, canWrite=reason is None)
    if private is False:
        answer['alternative'] = 'notion'  # the web suggests the Notion page to a team that does not want it public
    if reason is None and action == 'link' and private is False and data.get('acceptPublic') is not True:
        reason = 'public-needs-consent'
    if reason is not None or action == 'verify':
        return dict(answer, ok=reason is None, **({'reason': reason} if reason else {}))
    with authorized(server.dsn, token, team_id) as (c, user_id):
        team_lock(c, team_id)
        row = save_repo_link(c, team_id, user_id, repo, branch, secret, private)
    _remember(server, team_id, row)
    return dict(answer, ok=True, repo=repo_status(server, team_id))


def _link_input(data, stored):
    """(repo, branch, token) from a link or verify body, or the refusal reason. A missing token reuses the stored
    one only for the same repository, so nobody can point the team's token at another repository."""
    repo, branch, secret = data.get('repo'), data.get('branch', 'main'), data.get('token')
    accept = data.get('acceptPublic', False)
    if not isinstance(repo, str) or not isinstance(branch, str) or not isinstance(accept, bool) \
            or not (secret is None or isinstance(secret, str)):
        raise ValueError('레포 연결 필드 형식 오류')
    repo = re.sub(r'^(?:https?://)?(?:www\.)?github\.com/', '', repo.strip()).removesuffix('/').removesuffix('.git')
    branch = branch.strip() or 'main'
    if not REPO_NAME.fullmatch(repo) or not BRANCH_NAME.fullmatch(branch):
        return 'bad-format'
    secret = (secret or '').strip()
    if not secret:
        if stored is None or stored['repo'].lower() != repo.lower():
            return 'token-needed'
        secret = stored['token']
    elif not TOKEN_TEXT.fullmatch(secret):
        return 'bad-format'
    return repo, branch, secret
