"""The connector framework (docs/connectors.md): what Notion, Google Docs and later providers build on.

A provider reads documents of one outside service on this PC, with a token that never leaves the PC. The framework
turns each document into turns.append messages and hands them to turn_intake.append, so masking, the on-device privacy
check, the review inbox and "only approved cards go to the team server" apply to them exactly as to a chat.

    provider.fetch(pipeline, scope) -> (documents, new_cursor)      # a provider's only job besides its setup form
    ingest(pipeline, site, scope_id, documents) -> {documents, sent, skipped}
    run_scope / run_all / watch                                      # fetch + ingest, on a button or every 5 minutes

A Document is {source_id, title, url?, modified: aware datetime, sections: [{heading, text, author_is_me}]}.
author_is_me: True (written by this user), False (somebody else: skipped), None (author unknown: kept only because
the user confirmed they own the document, so the provider decides).
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import threading
import time
import unicodedata

from ai.syncup_ai.config import MAX_USER_CHARS
import batch_queue
from collection_session import active, config, require_active
from diagnostics import failure
from private_files import make_private_directory, read_private_file
from storage import connect
import turn_intake

# A user message is checked on this PC and sent to the classifier only up to this many characters (docs/privacy.md 2).
CHUNK_CHARS = MAX_USER_CHARS
RUN_SECONDS = 300  # watch(): how often every enabled scope is read, like the ChatGPT sync
SITE_NAME = re.compile(r'[a-z][a-z0-9-]{0,39}')
MAX_HEADING = 200
MAX_SOURCE_ID = 200
MAX_SCOPE_ID = 300
MAX_TITLE = 200
TOKEN_LIMIT = 64 * 1024
NOT_ACTIVE = '수집이 일시중지되었거나 종료되었습니다.'
# One import at a time: a button press waits for the 5-minute run instead of racing it.
_RUN_LOCK = threading.RLock()


# ---------------------------------------------------------------------------------------------------------------------
# Provider interface and registry

class ConnectorError(Exception):
    """A provider's failure, safe to show and to store: `kind` is a short code ('auth', 'rate_limit', 'network',
    'not_found', ...) and `status` the HTTP status when there was one. Never put text, URLs or response bodies in it."""

    def __init__(self, kind, status=None):
        super().__init__(kind)
        self.kind, self.status = kind, status


class Provider:
    """One outside service. Subclass it, set `site` (one of turn_intake.INTAKE_SITES) and `label`, call register().

    Settings and tokens: the provider keeps them in its own token file, load_token(state_dir(pipeline), self.site) /
    save_token(...). Neither the file nor a token value may appear in a return value or an error text.
    """
    site: str = ''
    label: str = ''

    def status(self, pipeline) -> dict:
        """{'connected': bool, 'tokenSet': bool, 'needs': str | None}. needs: what the user still has to do (Korean)."""
        token = load_token(state_dir(pipeline), self.site)
        return dict(connected=bool(token), tokenSet=bool(token), needs=None if token else '연결 정보를 입력하세요.')

    def setup_html(self, pipeline) -> str:
        """The inputs of this provider's setup form (no <form>, no csrf, no 저장 button: connectors/page.py adds them).
        Extra submit buttons with a name/value pair are fine; the pressed one arrives in the form dict."""
        return ''

    def handle_setup(self, pipeline, form: dict) -> str:
        """form: {input name: value} of one POST of setup_html (single str values). Store the token or settings with
        save_token and return a Korean message for the user. ValueError(Korean text) for a form the user must fix."""
        raise ValueError('이 연결은 설정할 것이 없습니다.')

    def fetch(self, pipeline, scope: dict) -> tuple[list[dict], str | None]:
        """Read the scope; (documents, new_cursor). new_cursor None keeps the stored cursor.

        scope is the connector_scopes row: team_id, site, scope_id, title, enabled, cursor, last_run, last_error,
        imported. Raise ConnectorError(kind, status) for a failure worth showing; anything else is shown by its type."""
        raise NotImplementedError

    def disconnect(self, pipeline) -> None:
        """Forget the connection: the default deletes the token file. Revoke at the service first if it has an endpoint."""
        delete_token(state_dir(pipeline), self.site)

    def handle_callback(self, pipeline, query: dict) -> str:
        """Optional: the browser came back to /connectors/callback/<site>?... (OAuth). query: {name: value}.
        Return a Korean message. This is a GET without the form csrf, so check your own `state` value."""
        raise ValueError('이 연결은 로그인 돌아오기를 쓰지 않습니다.')


PROVIDERS: dict[str, Provider] = {}


def register(provider):
    """Add a provider to PROVIDERS (a module registers its own instance at the bottom). Returns it."""
    if not SITE_NAME.fullmatch(provider.site or '') or provider.site not in turn_intake.INTAKE_SITES or not provider.label:
        raise ValueError('연결 서비스 이름을 확인하세요.')
    PROVIDERS[provider.site] = provider
    return provider


def load_providers():
    """Import the provider modules that exist (collector/connectors/notion.py, google_docs.py) so they register.

    Written as plain imports so the Windows bundle (PyInstaller) finds them; a module that is not there yet is skipped,
    and one that fails to import is logged and skipped so it cannot stop the collector.
    """
    try:
        import connectors.notion  # noqa: F401
    except ModuleNotFoundError as error:
        if error.name != 'connectors.notion':
            failure('connector_import', error)
    except Exception as error:
        failure('connector_import', error)
    try:
        import connectors.google_docs  # noqa: F401
    except ModuleNotFoundError as error:
        if error.name != 'connectors.google_docs':
            failure('connector_import', error)
    except Exception as error:
        failure('connector_import', error)
    return PROVIDERS


def provider_for(site):
    load_providers()
    provider = PROVIDERS.get(site) if isinstance(site, str) else None
    if provider is None:
        raise ValueError('연결할 서비스를 확인하세요.')
    return provider


def provider_status(pipeline, provider):
    """provider.status reduced to {connected, tokenSet, needs}: nothing else a provider returns gets out."""
    try:
        raw = provider.status(pipeline)
        needs = raw.get('needs')
        return dict(connected=raw.get('connected') is True, tokenSet=raw.get('tokenSet') is True,
                    needs=scrub(pipeline, provider.site, needs)[:200] if isinstance(needs, str) and needs else None)
    except Exception as error:
        failure('connector_status', error)
        return dict(connected=False, tokenSet=False, needs='연결 상태를 확인하지 못했습니다.')


def state_dir(pipeline):
    """The state folder (where private.sqlite lives): <state>/connectors/<site>.json holds the tokens."""
    return Path(pipeline.db).parent


def local_page_url(pipeline, path='/'):
    """http://127.0.0.1:<port><path> of this collector's local page (OAuth redirect URIs), or None before it listens."""
    port = getattr(pipeline, 'page_port', None)
    return f'http://127.0.0.1:{port}{path}' if type(port) is int else None


# ---------------------------------------------------------------------------------------------------------------------
# Token store: <state>/connectors/<site>.json, private folder, file mode 0600

def _token_path(folder, site):
    if not isinstance(site, str) or not SITE_NAME.fullmatch(site):
        raise ValueError('연결 서비스 이름을 확인하세요.')
    return Path(folder) / 'connectors' / f'{site}.json'


def save_token(folder, site, data):
    """Write the connection data (a JSON object: token, refresh token, expiry, settings) of one service."""
    if not isinstance(data, dict) or not data:
        raise ValueError('저장할 연결 정보를 확인하세요.')
    path = _token_path(folder, site)
    try:
        body = json.dumps(data, ensure_ascii=False).encode()
    except (TypeError, ValueError):
        raise ValueError('저장할 수 없는 연결 정보입니다.') from None
    if len(body) > TOKEN_LIMIT:
        raise ValueError('연결 정보가 너무 큽니다.')
    make_private_directory(path.parent)
    if sys.platform != 'win32':
        os.chmod(path.parent, 0o700)
    temp = path.with_name(f'.{site}.{secrets.token_hex(6)}.tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    fd = os.open(temp, flags, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(body)
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def load_token(folder, site):
    """The stored connection data, or None when the service was never connected. ValueError when the file is
    readable by other accounts or is not a JSON object (the text says so; it never holds file content)."""
    path = _token_path(folder, site)
    try:
        raw = read_private_file(path, TOKEN_LIMIT + 1, '연결 정보 파일을 이 계정만 읽을 수 있게 고치세요.')
    except FileNotFoundError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValueError('연결 정보 파일이 올바르지 않습니다.') from None
    if not isinstance(data, dict):
        raise ValueError('연결 정보 파일이 올바르지 않습니다.')
    return data


def delete_token(folder, site):
    _token_path(folder, site).unlink(missing_ok=True)


def _secret_strings(value):
    if isinstance(value, str):
        return [value] if len(value) >= 8 else []
    if isinstance(value, dict):
        return [s for v in value.values() for s in _secret_strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _secret_strings(v)]
    return []


def scrub(pipeline, site, text):
    """text with every long string value of the site's token file replaced by '…': a provider that echoes its token
    into a status line, a form or a message still cannot show it. Unreadable token files scrub nothing."""
    try:
        token = load_token(state_dir(pipeline), site)
    except (ValueError, OSError):
        return text
    for secret in sorted(_secret_strings(token), key=len, reverse=True):
        text = text.replace(secret, '…')
    return text


# ---------------------------------------------------------------------------------------------------------------------
# Document -> turns.append messages

_INVISIBLE = dict.fromkeys(map(ord, '​‌‍⁠﻿'))
_SENTENCE_END = re.compile(r'(?<=[.!?。！？])\s+')
_LEVELS = ((re.compile(r'\n'), '\n'), (_SENTENCE_END, ' '), (re.compile(r'\s+'), ' '))


def normalize(text):
    """The text a fingerprint is taken of: width variants folded, invisible characters dropped, whitespace runs one
    space, so a whitespace-only edit is not a new message (docs/connectors.md)."""
    return ' '.join(unicodedata.normalize('NFKC', text).translate(_INVISIBLE).split())


def fingerprint(text):
    return hashlib.sha256(normalize(text).encode()).hexdigest()


def _fit(text, limit, level=0):
    """text as pieces of at most `limit` characters: whole, else cut at lines, then sentences, then words, then anywhere."""
    if len(text) <= limit:
        return [text]
    if level == len(_LEVELS):
        return [text[i:i + limit] for i in range(0, len(text), limit)]
    pattern, joiner = _LEVELS[level]
    parts = [p.strip() for p in pattern.split(text) if p.strip()]
    if len(parts) <= 1:
        return _fit(text, limit, level + 1)
    pieces, current = [], ''
    for part in parts:
        for piece in _fit(part, limit, level + 1):
            joined = current + joiner + piece if current else piece
            if len(joined) <= limit:
                current = joined
            else:
                pieces.append(current)
                current = piece
    return pieces + [current] if current else pieces


def split_text(text, limit=CHUNK_CHARS):
    """text as chunks of at most `limit` characters, cut at paragraph boundaries first (a blank line), then at the
    boundaries _fit tries when one paragraph is longer than that. Blank text gives no chunk."""
    paragraphs = re.split(r'\n\s*\n', text.replace('\r\n', '\n').replace('\r', '\n'))
    chunks, current = [], ''
    for paragraph in paragraphs:
        if not paragraph.strip():
            continue
        for piece in _fit(paragraph.strip(), limit):
            joined = current + '\n\n' + piece if current else piece
            if len(joined) <= limit:
                current = joined
            else:
                chunks.append(current)
                current = piece
    return chunks + [current] if current else chunks


def _source_key(source_id):
    """The id of a document inside message ids: as given, or its hash when it is too long for an id field."""
    if not isinstance(source_id, str) or not source_id.strip():
        raise ValueError('문서 id가 없습니다.')
    return source_id if len(source_id) <= MAX_SOURCE_ID else hashlib.sha256(source_id.encode()).hexdigest()[:40]


def _items(site, document):
    """[(item_key, content_hash, message)] of one document: one per chunk of each section its user wrote."""
    if not isinstance(document, dict) or not isinstance(document.get('sections'), list):
        raise ValueError('문서 형식 오류')
    modified = document.get('modified')
    if not isinstance(modified, datetime) or modified.tzinfo is None:
        raise ValueError('문서 수정 시각에 시간대가 필요합니다.')
    source = _source_key(document.get('source_id'))
    conversation = f'{site}:{source}'
    items = []
    for index, section in enumerate(document['sections']):
        if not isinstance(section, dict) or not isinstance(section.get('text'), str):
            raise ValueError('문서 절 형식 오류')
        author = section.get('author_is_me', 'missing')
        if author is not None and type(author) is not bool:  # a missing or odd value must not pass as "mine"
            raise ValueError('문서 절의 작성자 표시(author_is_me)가 필요합니다.')
        if author is False:  # 내 글만: somebody else's text never gets in, not even to the disk
            continue
        heading = ' '.join(str(section.get('heading') or '').split())[:MAX_HEADING]
        budget = CHUNK_CHARS - len(heading) - 1 if heading else CHUNK_CHARS
        for n, chunk in enumerate(split_text(section['text'], budget)):
            text = f'{heading}\n{chunk}' if heading else chunk
            digest = fingerprint(text)
            message = dict(id=f'{site}:{source}:{digest[:12]}:{n}', text=text, conversationId=conversation, site=site,
                           role='user', collectedAt=modified.isoformat(), turnId=f'{conversation}:{index}')
            items.append((source, digest, message))
    return items


def build_messages(site, document):
    """The turns.append messages of one document (see the module text). ValueError for a malformed document."""
    return [message for _, _, message in _items(site, document)]


# ---------------------------------------------------------------------------------------------------------------------
# Scopes, import and runs

def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat() if timestamp is not None else None


def _team(c):
    row = c.execute('SELECT team_id FROM sharing').fetchone()
    return row[0] if row else None


def scope_info(row):
    """A connector_scopes row as the RPC and the page show it (never the cursor)."""
    return dict(site=row['site'], scopeId=row['scope_id'], title=row['title'], enabled=bool(row['enabled']),
                lastRun=_iso(row['last_run']), lastError=row['last_error'], imported=row['imported'])


def list_scopes(pipeline, site=None):
    """The scope rows of the bound team (of one site), as dicts."""
    with connect(pipeline.db) as c:
        team_id = _team(c)
        if not team_id:
            return []
        sql = 'SELECT * FROM connector_scopes WHERE team_id=?' + (' AND site=?' if site else '') + ' ORDER BY rowid'
        return [dict(r) for r in c.execute(sql, (team_id, site) if site else (team_id,))]


def set_scope(pipeline, site, scope_id, title=None, enabled=None):
    """Create a scope or change its title and enabled flag; a new scope is on unless enabled says otherwise.
    Returns scope_info of it. ValueError for an unknown service, an odd id or no chosen team."""
    provider_for(site)
    if not isinstance(scope_id, str) or not scope_id.strip() or len(scope_id) > MAX_SCOPE_ID:
        raise ValueError('범위 id를 확인하세요.')
    if title is not None and (not isinstance(title, str) or len(title) > MAX_TITLE):
        raise ValueError('범위 이름을 확인하세요.')
    if enabled is not None and type(enabled) is not bool:
        raise ValueError('사용 여부를 확인하세요.')
    scope_id = scope_id.strip()
    with pipeline.write() as c:
        team_id = _team(c)
        if not team_id:
            raise ValueError('공유할 팀을 먼저 선택하세요.')
        row = c.execute('SELECT * FROM connector_scopes WHERE team_id=? AND site=? AND scope_id=?',
                        (team_id, site, scope_id)).fetchone()
        if row is None:
            c.execute('INSERT INTO connector_scopes(team_id,site,scope_id,title,enabled) VALUES(?,?,?,?,?)',
                      (team_id, site, scope_id, (title or '').strip(), int(enabled is not False)))
        else:
            c.execute('UPDATE connector_scopes SET title=coalesce(?,title),enabled=coalesce(?,enabled) '
                      'WHERE team_id=? AND site=? AND scope_id=?',
                      (title.strip() if title is not None else None, None if enabled is None else int(enabled),
                       team_id, site, scope_id))
        return scope_info(c.execute('SELECT * FROM connector_scopes WHERE team_id=? AND site=? AND scope_id=?',
                                    (team_id, site, scope_id)).fetchone())


def disconnect(pipeline, site):
    """Forget the connection to a service: the provider's own disconnect (revoking at the service), then the token file
    in any case. The scopes stay but are not read until the service is connected again. Returns the provider."""
    provider = provider_for(site)
    try:
        provider.disconnect(pipeline)
    except Exception as error:
        failure('connector_disconnect', error)
    delete_token(state_dir(pipeline), provider.site)
    return provider


def ingest(pipeline, site, scope_id, documents):
    """Hand the documents to turn_intake.append (nothing leaves this PC here) and note what was handed over.

    Messages already sent for this team (same document, same content fingerprint) are skipped; sections of other
    authors never become messages. Appends run in slices of 200; when all are in, only the batches of the documents
    imported now are flushed, so a chat in progress keeps its open batch.
    Returns {documents, sent, skipped}: documents given, messages handed over, messages skipped as already sent.
    ValueError while collection is paused or ended, or for a malformed document (nothing is recorded then).
    """
    if site not in turn_intake.INTAKE_SITES:
        raise ValueError('허용되지 않은 발화 출처입니다.')
    if not isinstance(documents, list):
        raise ValueError('문서 목록 형식 오류')
    _, binding = require_active(pipeline.db)
    team_id = binding['team_id']
    items = [item for document in documents for item in _items(site, document)]
    fresh, skipped, seen = [], 0, set()
    with connect(pipeline.db) as c:
        known = {(r[0], r[1]) for r in c.execute('SELECT item_key,content_hash FROM connector_items WHERE team_id=? AND site=?',
                                                 (team_id, site))}
    for item in items:
        key = item[:2]
        if key in known or key in seen:
            skipped += 1
        else:
            seen.add(key)
            fresh.append(item)
    conversations = set()
    for start in range(0, len(fresh), turn_intake.MAX_APPEND):
        part = fresh[start:start + turn_intake.MAX_APPEND]
        turn_intake.append(pipeline, [message for _, _, message in part])
        with pipeline.write() as c:
            now = time.time()
            c.executemany('INSERT OR IGNORE INTO connector_items VALUES(?,?,?,?,?)',
                          [(team_id, site, key, digest, now) for key, digest, _ in part])
        conversations.update(m['site'] + ':' + m['conversationId'] for _, _, m in part)
    if conversations:
        batch_queue.flush(pipeline, conversations)
    return dict(documents=len(documents), sent=len(fresh), skipped=skipped)


def error_kind(error):
    """A failure as it is stored and shown: a short code and the HTTP status, never the message."""
    if isinstance(error, ConnectorError):
        kind, status = error.kind, error.status
    else:
        kind, status = type(error).__name__, getattr(error, 'code', None)
    kind = re.sub(r'[^A-Za-z0-9_.-]', '', str(kind))[:40] or 'error'
    return f'{kind} {status}' if type(status) is int else kind


def run_scope(pipeline, site, scope_id):
    """Fetch one scope and ingest it. Returns {documents, sent, skipped}, plus `error` (kind and status only, also saved
    as the scope's last_error) when the provider or the import failed; the cursor moves only on success.
    ValueError for an unknown service or scope, a provider not connected, or collection paused or ended."""
    provider = provider_for(site)
    with _RUN_LOCK:
        _, binding = require_active(pipeline.db)
        key = (binding['team_id'], site, scope_id)
        with connect(pipeline.db) as c:
            row = c.execute('SELECT * FROM connector_scopes WHERE team_id=? AND site=? AND scope_id=?', key).fetchone()
        if row is None:
            raise ValueError('범위를 찾을 수 없습니다.')
        if not provider_status(pipeline, provider)['connected']:
            raise ValueError('먼저 서비스를 연결하세요.')
        try:
            documents, cursor = provider.fetch(pipeline, dict(row))
            counts = ingest(pipeline, site, scope_id, documents)
        except Exception as error:
            if not active(config(pipeline.db)):  # paused while it ran: not a failure of the service
                raise ValueError(NOT_ACTIVE) from None
            failure('connector_' + site.replace('-', '_'), error)
            message = error_kind(error)
            with pipeline.write() as c:
                c.execute('UPDATE connector_scopes SET last_run=?,last_error=? WHERE team_id=? AND site=? AND scope_id=?',
                          (time.time(), message, *key))
            return dict(documents=0, sent=0, skipped=0, error=message)
        with pipeline.write() as c:
            c.execute('UPDATE connector_scopes SET cursor=coalesce(?,cursor),last_run=?,last_error=NULL,'
                      'imported=imported+? WHERE team_id=? AND site=? AND scope_id=?',
                      (cursor, time.time(), counts['sent'], *key))
        return counts


def _connected(pipeline, site):
    return site in PROVIDERS and provider_status(pipeline, PROVIDERS[site])['connected']


def run_selected(pipeline, site=None, scope_id=None):
    """The RPC and the page's button: run one scope, every enabled scope of one service, or of all services.
    Returns [{site, scopeId, documents, sent, skipped, error?}]; a service that is not connected is skipped, not an error.
    ValueError (Korean) for an unknown service or scope, a disabled scope, or collection paused or ended."""
    if scope_id is not None and site is None:
        raise ValueError('범위를 쓰려면 서비스를 함께 지정하세요.')
    if site is not None:
        provider_for(site)
    else:
        load_providers()
    require_active(pipeline.db)
    scopes = list_scopes(pipeline, site)
    if scope_id is not None:
        targets = [s for s in scopes if s['scope_id'] == scope_id]
        if not targets:
            raise ValueError('범위를 찾을 수 없습니다.')
        if not targets[0]['enabled']:
            raise ValueError('먼저 이 범위를 켜세요.')
    else:
        targets = [s for s in scopes if s['enabled'] and _connected(pipeline, s['site'])]
    results = []
    with _RUN_LOCK:
        for scope in targets:
            results.append(dict(site=scope['site'], scopeId=scope['scope_id'],
                                **run_scope(pipeline, scope['site'], scope['scope_id'])))
    return results


def run_all(pipeline):
    """Import every enabled scope of every connected service. Does nothing while collection is paused or ended
    (or no team is chosen), and returns [] then."""
    if not active(config(pipeline.db)):
        return []
    try:
        return run_selected(pipeline)
    except ValueError:  # paused or ended between the check and the run, or no team chosen yet
        return []


def watch(pipeline, interval=RUN_SECONDS, stop=None):
    """The connector thread (app.py): run_all every `interval` seconds until `stop` (a threading.Event) is set.
    Quiet on errors: a failing service is recorded on its scope (last_error), not shown; anything else is logged."""
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            run_all(pipeline)
        except Exception as error:
            failure('connectors', error)
        stop.wait(interval)
