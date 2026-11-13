"""Turn intake: validate turns from the extension and the scanner, store them privately, quarantine what cannot be used."""
from datetime import datetime, timezone
import json
import time

from ai.syncup_ai.mask import mask
import batch_queue
from collection_session import bound_team, require_active
from collection_settings import classification_context, local_profile, sync_windows
from stable_ids import digest
from storage import connect

MESSAGE_FIELDS = ('id', 'text', 'conversationId', 'site', 'role', 'collectedAt')
# Optional fields of shared/collector.ts, checked and stored only when sent. Account sync (origin 'sync') needs all three.
SYNC_FIELDS = ('origin', 'createdAt', 'turnId')
ORIGINS = ('screen', 'sync')
INTAKE_SITES = ('chatgpt', 'manual', 'chatgpt-export')
MAX_MESSAGE_TEXT = 20000
MAX_MESSAGE_FIELD = 1200
MAX_APPEND = 200
# Quarantined input of one team that nobody retried or dismissed yet. Param: team id.
UNRESOLVED_ISSUES = '''SELECT * FROM intake_issues WHERE team_id=? AND id NOT IN (SELECT issue_id FROM intake_resolutions)
    ORDER BY received'''
# Jobs the Rust scanner queued that intake has not taken yet; every batch job has a job_context row.
SCANNED_JOBS = "SELECT * FROM jobs WHERE state='new' AND id NOT IN (SELECT job FROM job_context)"
# A screen-path answer stored after a given row of the same conversation. Params: team, conversation, rowid, session.
SCREEN_ANSWER_AFTER = '''SELECT 1 FROM intake WHERE team_id=? AND conversation=? AND rowid>?
    AND json_extract(message,'$.session')=? AND json_extract(message,'$.role')='assistant'
    AND coalesce(json_extract(message,'$.origin'),'screen')='screen' LIMIT 1'''


def created_at(message):
    """Unix seconds of the message's createdAt, an ISO time with a time zone; ValueError otherwise."""
    value = message['createdAt']
    if not isinstance(value, str):
        raise ValueError('발화 작성 시각 오류')
    moment = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if moment.tzinfo is None:
        raise ValueError('발화 시각에 시간대가 필요합니다.')
    try:
        return moment.timestamp()
    except OverflowError:
        raise ValueError('발화 작성 시각 오류') from None


def _sync_fields(message):
    """The SYNC_FIELDS the message has, checked (C2); ValueError when one is malformed."""
    fields ={k: message[k] for k in SYNC_FIELDS if k in message}
    if fields.get('origin', 'screen') not in ORIGINS:
        raise ValueError('발화 경로 오류')
    if 'createdAt' in fields:
        created_at(fields)
    turn = fields.get('turnId')
    if 'turnId' in fields and (not isinstance(turn, str) or not 0 < len(turn) <= MAX_MESSAGE_FIELD):
        raise ValueError('턴 식별자 오류')
    if fields.get('origin') == 'sync' and ({'createdAt', 'turnId'} - set(fields) or message['site'] != 'chatgpt'):
        raise ValueError('동기화 발화 필드 오류')
    return fields


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
    return ({k: message[k] for k in MESSAGE_FIELDS} | {'roleGuessed': message.get('roleGuessed', False)}
            | _sync_fields(message))


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
    # C4-a: the screen path (no origin) and account sync read one message differently (rendered text, Markdown source),
    # so another origin is a duplicate: the row stored first stays.
    if previous.get('origin', 'screen') != message.get('origin', 'screen'):
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


def _sync_turn(message):
    """(conversationId, turnId) of an account sync message; None for the screen path."""
    return (message['conversationId'], message['turnId']) if message.get('origin') == 'sync' else None


def _in_window(turn, windows):
    """C3: the turn's earliest and latest createdAt lie in one window [start, end)."""
    times = [created_at(m) for m in turn]
    return any(start <= min(times) and max(times) < end for start, end in windows)


def _screen_has_turn(c, team_id, start, conversation, turn_id):
    """C4-b: True when this sync turn must not be taken because the screen path already has it.

    Its question (chatgpt:<turnId>) is stored and a screen answer follows it in the conversation, or the question is
    already batched: taking the turn would repeat it or add answers without their question. A stored question still
    waiting for its answer gets the turnId (text unchanged), so batch.group_turns pairs it with the sync answer.
    """
    identifier = intake_id(team_id, start, dict(site='chatgpt', conversationId=conversation, id='chatgpt:' + turn_id))
    question = c.execute('SELECT rowid,job,message FROM intake WHERE id=?', (identifier,)).fetchone()
    if not question:
        return False
    if question['job'] is not None or c.execute(
            SCREEN_ANSWER_AFTER, (team_id, 'chatgpt:' + conversation, question['rowid'], start)).fetchone():
        return True
    saved = json.loads(question['message'])
    if 'turnId' not in saved:
        c.execute('UPDATE intake SET message=? WHERE id=?',
                  (json.dumps(dict(saved, turnId=turn_id), ensure_ascii=False), identifier))
    return False


def append(pipeline, messages, flush=False):
    """turns.append: store valid turns, quarantine invalid ones, queue every batch that is ready.

    Account sync turns (origin 'sync') are kept only inside the sync windows and when the screen path has not
    already taken them (sync-contract.md 3-3); screen-path calls answer 0 for the three turn counts.
    """
    if not isinstance(messages, list) or not 0 < len(messages) <= MAX_APPEND:
        raise ValueError('발화는 한 번에 1~200개를 보내세요.')
    clean, rejected = [], []
    for m in messages:
        try:
            clean.append(clean_message(m))
        except ValueError:
            rejected.append(m)
    turns = {}
    for m in clean:
        if _sync_turn(m):
            turns.setdefault(_sync_turn(m), []).append(m)
    with pipeline.write() as c:
        s, binding = require_active(pipeline.db)
        team_id = binding['team_id']
        context = classification_context(c, team_id, local_profile(c))
        issues = [quarantine(c, m, team_id, s['start'], 'invalid_message') for m in rejected]
        windows = sync_windows(c, s)
        outside = {key for key, turn in turns.items() if not _in_window(turn, windows)}
        skipped = {key for key in turns.keys() - outside if _screen_has_turn(c, team_id, s['start'], *key)}
        dropped, stored = outside | skipped, []
        for m in clean:
            if _sync_turn(m) not in dropped and store_messages(c, [m], team_id, s['start'], issues):
                stored.append(m)
        batch_queue.queue_ready_batches(c, team_id, context, flush)
    return dict(newMessages=len(stored), queued=bool(clean), intakeIssues=issues, outsideWindow=len(outside),
                skippedTurns=len(skipped), newTurns=len({_sync_turn(m) for m in stored} - {None}))


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
    with pipeline.write() as c:
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
    # A manual message: account sync fields would break the rule that origin 'sync' comes from site 'chatgpt'.
    message = {k: v for k, v in clean_message(message).items() if k not in SYNC_FIELDS}
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
    with pipeline.write() as c:
        team_id = bound_team(c)
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


def unresolved_issues(c, team_id):
    return [dict(r) for r in c.execute(UNRESOLVED_ISSUES, (team_id,))]


def intake_issues(pipeline):
    """intake.issues"""
    with connect(pipeline.db) as c:
        return dict(items=unresolved_issues(c, bound_team(c)))
