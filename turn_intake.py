"""Turn intake: validate turns from the extension and the scanner, store them privately, quarantine what cannot be used."""
from datetime import datetime, timezone
import json
import time

from ai.syncup_ai.mask import mask
import batch_queue
from collection_settings import classification_context, local_profile, require_active
from storage import connect
from turn_pipeline import digest

MESSAGE_FIELDS = ('id', 'text', 'conversationId', 'site', 'role', 'collectedAt')
INTAKE_SITES = ('chatgpt', 'manual', 'chatgpt-export')
MAX_MESSAGE_TEXT = 20000
MAX_MESSAGE_FIELD = 1200
MAX_APPEND = 200
# Quarantined input of one team that nobody retried or dismissed yet. Param: team id.
UNRESOLVED_ISSUES = '''FROM intake_issues WHERE team_id=? AND id NOT IN (SELECT issue_id FROM intake_resolutions)
    ORDER BY received'''
# Jobs the Rust scanner queued that intake has not taken yet; every batch job has a job_context row.
SCANNED_JOBS = "SELECT * FROM jobs WHERE state='new' AND id NOT IN (SELECT job FROM job_context)"


def clean_message(message):
    if not isinstance(message, dict):
        raise ValueError('발화 형식 오류')
    for key in MESSAGE_FIELDS:
        value = message.get(key)
        limit = MAX_MESSAGE_TEXT if key == 'text' else MAX_MESSAGE_FIELD
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ValueError('발화 필드 오류')
    if message['role'] not in ('user', 'assistant') or message['site'] not in INTAKE_SITES:
        raise ValueError('허용되지 않은 발화 출처입니다.')
    if datetime.fromisoformat(message['collectedAt'].replace('Z', '+00:00')).tzinfo is None:
        raise ValueError('발화 시각에 시간대가 필요합니다.')
    if type(message.get('roleGuessed', False)) is not bool:
        raise ValueError('화자 상태 오류')
    return {k: message[k] for k in MESSAGE_FIELDS} | {'roleGuessed': message.get('roleGuessed', False)}


def intake_id(team_id, start, message):
    return digest([team_id, start, message['site'], message['conversationId'], message['id']])


def quarantine(c, message, team_id, start, reason):
    """Keep input that cannot be processed (masked) for the user to retry or dismiss; returns the issue summary."""
    saved = mask(json.dumps(message, ensure_ascii=False))[0]
    identifier = digest([team_id, start, reason, saved])
    c.execute('INSERT OR IGNORE INTO intake_issues VALUES(?,?,?,?,?)',
              (identifier, team_id, reason, json.dumps(saved), time.time()))
    message_id = message.get('id') if isinstance(message, dict) and isinstance(message.get('id'), str) else None
    return dict(id=identifier, reason=reason, messageId=message_id)


def _quarantine_if_changed(c, previous, message, team_id, start, issues):
    # Text cleared by retention: the message was already processed, so a re-send is not a change.
    if previous.get('purged'):
        return
    if any(previous[k] != message[k] for k in ('text', 'role', 'roleGuessed')):
        issue = quarantine(c, message, team_id, start, 'message_changed')
        if issues is not None:
            issues.append(issue)


def store_messages(c, messages, team_id, start, issues=None):
    """Insert new messages (masked) into intake; a changed re-send goes to quarantine. Returns how many were new."""
    count = 0
    for m in messages:
        identifier = intake_id(team_id, start, m)
        m = dict(m, session=start)
        m['text'], m['masked'] = mask(m['text'])
        existing = c.execute('SELECT message FROM intake WHERE id=?', (identifier,)).fetchone()
        if existing:
            _quarantine_if_changed(c, json.loads(existing[0]), m, team_id, start, issues)
            continue
        c.execute('INSERT INTO intake VALUES(?,?,?,?,NULL,?)',
                  (identifier, team_id, m['site'] + ':' + m['conversationId'], json.dumps(m, ensure_ascii=False), time.time()))
        count += 1
    return count


def append(pipeline, messages, flush=False):
    """turns.append: store valid turns, quarantine invalid ones, queue every batch that is ready."""
    if not isinstance(messages, list) or not 0 < len(messages) <= MAX_APPEND:
        raise ValueError('발화는 한 번에 1~200개를 보내세요.')
    clean, rejected = [], []
    for m in messages:
        try:
            clean.append(clean_message(m))
        except ValueError:
            rejected.append(m)
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        s, binding = require_active(pipeline.db)
        team_id = binding['team_id']
        context = classification_context(c, team_id, local_profile(c))
        issues = [quarantine(c, m, team_id, s['start'], 'invalid_message') for m in rejected]
        count = store_messages(c, clean, team_id, s['start'], issues)
        batch_queue.queue_ready_batches(c, team_id, context, flush)
    return dict(newMessages=count, queued=bool(clean), intakeIssues=issues)


def _scanned_messages(job):
    """A scanner job's excerpts as intake messages; the Codex and Claude Code scanners name some fields differently."""
    messages = []
    for e in json.loads(job['evidence']):
        stamp = e.get('at', e.get('timestamp', time.time()))
        messages.append(dict(
            id=job['id'] + ':' + str(e['n']),
            site=e.get('source', 'codex'),
            role=e['role'],
            roleGuessed=False,
            text=e['text'],
            conversationId=e.get('conversationId', e.get('session_id', job['id'])),
            collectedAt=datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
            turnId=e.get('turnId', job['id']),
            complete=True,
        ))
    return messages


def capture_scanned_jobs(pipeline):
    """Move new Codex / Claude Code jobs from the Rust scanner into intake, then queue ready batches."""
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        s, binding = require_active(pipeline.db)
        team_id = binding['team_id']
        context = classification_context(c, team_id, local_profile(c))
        for job in c.execute(SCANNED_JOBS).fetchall():
            store_messages(c, _scanned_messages(job), team_id, s['start'])
            c.execute("UPDATE jobs SET state='done',detail='통합 분류 대기함에 저장됨' WHERE id=?", (job['id'],))
        batch_queue.queue_ready_batches(c, team_id, context)


def _queue_correction(pipeline, c, team_id, issue_id, message):
    """The user's corrected text becomes new private input, never an edit of collected evidence. Returns its id."""
    s, _ = require_active(pipeline.db, team_id)
    message = clean_message(message)
    message.update(id='intake-retry-' + issue_id, site='manual')
    context = classification_context(c, team_id, local_profile(c))
    if store_messages(c, [message], team_id, s['start']) != 1:
        raise ValueError('복구 입력이 이미 존재합니다.')
    identifier = intake_id(team_id, s['start'], message)
    saved = json.loads(c.execute('SELECT message FROM intake WHERE id=?', (identifier,)).fetchone()[0])
    batch_queue.queue_batch(c, [dict(saved, intakeId=identifier)], team_id, dict(context, trigger='manual'))
    return message['id']


def resolve_intake(pipeline, params, action):
    """intake.retry / intake.dismiss. One transaction under the lock: on failure nothing is recorded."""
    if not isinstance(params.get('id'), str) or not isinstance(params.get('teamId'), str):
        raise ValueError('입력과 대상 팀을 확인하세요.')
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        team_id = c.execute('SELECT team_id FROM sharing').fetchone()[0]
        issue = c.execute('SELECT id FROM intake_issues WHERE id=? AND team_id=?', (params['id'], team_id)).fetchone()
        if not issue or params['teamId'] != team_id:
            raise ValueError('현재 팀의 입력이 아닙니다.')
        previous = c.execute('SELECT action,replacement_id FROM intake_resolutions WHERE issue_id=?', (params['id'],)).fetchone()
        if previous:
            if previous['action'] != action:
                raise ValueError('이미 다른 방식으로 처리한 입력입니다.')
            return dict(ok=True, alreadyResolved=True, replacementId=previous['replacement_id'])
        replacement = _queue_correction(pipeline, c, team_id, params['id'], params.get('message')) if action == 'retry' else None
        c.execute('INSERT INTO intake_resolutions VALUES(?,?,?,?)', (params['id'], action, replacement, time.time()))
    return dict(ok=True, alreadyResolved=False, replacementId=replacement)


def unresolved_issues(c, team_id, columns='*'):
    return [dict(r) for r in c.execute(f'SELECT {columns} {UNRESOLVED_ISSUES}', (team_id,))]


def intake_issues(pipeline):
    """intake.issues"""
    with connect(pipeline.db) as c:
        return dict(items=unresolved_issues(c, c.execute('SELECT team_id FROM sharing').fetchone()[0]))
