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
# '팀 기록 불러오기' pastes the team board (web/src/lib/board-markdown.ts, head line '# 싱크업 팀 기록 (date)') and, from
# the extension, the end line after it (sync-contract.md 8장). Pasted back into a chat, it is not the user's own words.
TEAM_RECORD_HEAD = '# 싱크업 팀 기록'
TEAM_RECORD_END = '<!-- 싱크업 팀 기록 끝 -->'
MAX_MESSAGE_TEXT = 20000
MAX_MESSAGE_FIELD = 1200
MAX_APPEND = 200
# Quarantined input of one team that nobody retried or dismissed yet. Param: team id.
UNRESOLVED_ISSUES = '''SELECT * FROM intake_issues WHERE team_id=? AND id NOT IN (SELECT issue_id FROM intake_resolutions)
    ORDER BY received'''
# Jobs the Rust scanner queued that intake has not taken yet; every batch job has a job_context row.
SCANNED_JOBS = "SELECT * FROM jobs WHERE state='new' AND id NOT IN (SELECT job FROM job_context)"
# A screen-path answer to a stored question: after it, with no screen-path question of the conversation in between.
SCREEN_ANSWER = '''SELECT 1 FROM intake a WHERE a.team_id=:team AND a.conversation=:conversation AND a.rowid>:question
    AND json_extract(a.message,'$.session')=:session AND json_extract(a.message,'$.role')='assistant'
    AND coalesce(json_extract(a.message,'$.origin'),'screen')='screen'
    AND NOT EXISTS (SELECT 1 FROM intake u WHERE u.team_id=:team AND u.conversation=:conversation
        AND u.rowid>:question AND u.rowid<a.rowid AND json_extract(u.message,'$.session')=:session
        AND json_extract(u.message,'$.role')='user' AND coalesce(json_extract(u.message,'$.origin'),'screen')='screen')
    LIMIT 1'''
# The screen-path row of the conversation just before a given row.
SCREEN_ROW_BEFORE = '''SELECT rowid,id,job,message FROM intake WHERE team_id=:team AND conversation=:conversation
    AND rowid<:row AND json_extract(message,'$.session')=:session
    AND coalesce(json_extract(message,'$.origin'),'screen')='screen' ORDER BY rowid DESC LIMIT 1'''
# What C4-b does with a sync turn: store it (step 4 and on), skip it (skippedTurns), or let the screen rows that already
# hold its question and answer be the turn (its sync messages are not stored and not counted).
TAKE, SKIP, PAIRED = 'take', 'skip', 'paired'


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


def _row(c, identifier):
    return c.execute('SELECT rowid,id,job,message FROM intake WHERE id=?', (identifier,)).fetchone()


def _screen_row(c, identifier):
    """The intake row with this id when the screen path stored it, else None."""
    row = _row(c, identifier)
    return row if row and json.loads(row['message']).get('origin', 'screen') == 'screen' else None


def _fill_turn_id(c, row, turn_id):
    """Give a stored row the sync turn's turnId, text unchanged, so batch.group_turns pairs it with the sync turn."""
    saved = json.loads(row['message'])
    if 'turnId' not in saved:
        c.execute('UPDATE intake SET message=? WHERE id=?',
                  (json.dumps(dict(saved, turnId=turn_id), ensure_ascii=False), row['id']))


def _screen_question_before(c, team_id, start, conversation, answer):
    """The screen question paired with a screen answer row, or None.

    The conversation's screen row just before the answer must be a question (so no other screen answer lies between),
    not batched yet and without a turnId.
    """
    row = c.execute(SCREEN_ROW_BEFORE, dict(team=team_id, conversation='chatgpt:' + conversation, row=answer['rowid'],
                                            session=start)).fetchone()
    if not row or row['job'] is not None:
        return None
    saved = json.loads(row['message'])
    return row if saved['role'] == 'user' and 'turnId' not in saved else None


def _screen_overlap(c, team_id, start, turn):
    """C4-b: TAKE, SKIP or PAIRED for this sync turn, by what the screen path already has of it.

    Without a stored question (chatgpt:<turnId>), some of the turn's answers may be screen rows: the screen question
    was left in the baseline, had a hash id or was quarantined. Batched, the turn is skipped (its answer was classified).
    Not batched yet, they get the turnId. When the screen question just before them is found too (a hash id), it gets
    the turnId and the screen rows are the turn (PAIRED). Otherwise the turn is taken: the question is new, the answers
    are duplicates.
    With a stored question: a screen answer follows it before the conversation's next screen question (a later turn's
    answer is not this turn's), or the question is already batched. Taking the turn would repeat it or add answers
    without their question. A stored question still waiting for its answer gets the turnId.
    """
    conversation, turn_id = _sync_turn(turn[0])
    head = dict(site='chatgpt', conversationId=conversation, id='chatgpt:' + turn_id)
    question = _row(c, intake_id(team_id, start, head))
    if not question:
        answers = [_screen_row(c, intake_id(team_id, start, m)) for m in turn if m['role'] == 'assistant']
        answers = [r for r in answers if r]
        if not answers:
            return TAKE
        if any(r['job'] is not None for r in answers):
            return SKIP
        pair = _screen_question_before(c, team_id, start, conversation, min(answers, key=lambda r: r['rowid']))
        for row in answers + ([pair] if pair else []):
            _fill_turn_id(c, row, turn_id)
        return PAIRED if pair else TAKE
    if question['job'] is not None or c.execute(SCREEN_ANSWER, dict(
            team=team_id, conversation='chatgpt:' + conversation, question=question['rowid'], session=start)).fetchone():
        return SKIP
    _fill_turn_id(c, question, turn_id)
    return TAKE


def without_team_record(text):
    """text without the team records '팀 기록 불러오기' pasted into it, or None when it has none.

    A record runs from its head line through its end line, or through the end of the text when the end line is missing.
    """
    kept, inside, found = [], False, False
    for line in text.split('\n'):
        if inside:
            inside = line.strip() != TEAM_RECORD_END
        elif line.strip().startswith(TEAM_RECORD_HEAD):
            inside = found = True
        else:
            kept.append(line)
    return '\n'.join(kept).strip() if found else None


def _own_words(messages):
    """(messages with pasted team records cut from user text, how many user messages were nothing else)."""
    kept, skipped = [], 0
    for m in messages:
        text = without_team_record(m['text']) if m['role'] == 'user' else None
        if text == '':
            skipped += 1
        else:
            kept.append(m if text is None else dict(m, text=text))
    return kept, skipped


def append(pipeline, messages, flush=False):
    """turns.append: store valid turns, quarantine invalid ones, queue every batch that is ready.

    Account sync turns (origin 'sync') are kept only inside the sync windows and when the screen path has not
    already taken them; pasted team records leave every user message before storing (sync-contract.md 3-3).
    Screen-path calls answer 0 for the three turn counts.
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
        overlap = {key: _screen_overlap(c, team_id, s['start'], turn) for key, turn in turns.items() if key not in outside}
        skipped = {key for key, kind in overlap.items() if kind == SKIP}
        dropped = outside | {key for key, kind in overlap.items() if kind != TAKE}
        kept, team_records = _own_words([m for m in clean if _sync_turn(m) not in dropped])
        stored = []
        for m in kept:
            if store_messages(c, [m], team_id, s['start'], issues):
                stored.append(m)
        batch_queue.queue_ready_batches(c, team_id, context, flush)
    return dict(newMessages=len(stored), queued=bool(clean), intakeIssues=issues, outsideWindow=len(outside),
                skippedTurns=len(skipped), newTurns=len({_sync_turn(m) for m in stored} - {None}),
                teamRecordSkipped=team_records)


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
