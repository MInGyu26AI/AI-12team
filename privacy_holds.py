"""Privacy holds for local review: held batches, excluded messages, and the user's exclude / recheck requests.

Previews use format rules only and never leave the device.
"""
import json
import time

from collection_session import bound_team
from local_privacy import ALLOW, EXCLUDE
from privacy_rules import apply_rules
from storage import connect

MAX_EXCLUDED_LISTED = 200
# Params: team id.
HELD_BATCHES = '''SELECT p.job,p.reason,p.decided,p.detail,x.messages FROM privacy_jobs p
    JOIN job_context x ON x.job=p.job JOIN jobs j ON j.id=p.job
    WHERE x.team_id=? AND j.state='new' AND p.decision='hold' ORDER BY j.rowid'''
DECIDED_BATCHES = '''SELECT p.job,p.decided,p.detail,x.messages FROM privacy_jobs p JOIN job_context x ON x.job=p.job
    WHERE x.team_id=? ORDER BY p.decided DESC, p.job'''
# Params: job id, team id.
HELD_BATCH = '''SELECT p.detail,p.model,x.messages FROM privacy_jobs p JOIN job_context x ON x.job=p.job JOIN jobs j ON j.id=p.job
    WHERE p.job=? AND x.team_id=? AND j.state='new' AND p.decision='hold' '''


def _held_batch_view(row):
    decided = {d['id']: d for d in json.loads(row['detail'])}
    messages = []
    for m in json.loads(row['messages']):
        verdict = decided.get(m['id'], {})
        messages.append(dict(id=m['id'], role=m['role'], text=apply_rules(m['text'])[0], decision=verdict.get('decision'),
                             reason=verdict.get('reason'), categories=verdict.get('categories', [])))
    return dict(id=row['job'], reason=row['reason'], decidedAt=row['decided'], messages=messages)


def _excluded_messages(row):
    """One entry per excluded message of a decided batch, including the excluded part of an allowed batch."""
    messages = {m['id']: m for m in json.loads(row['messages'])}
    entries = []
    for d in json.loads(row['detail']):
        if d.get('decision') != EXCLUDE:
            continue
        m = messages.get(d['id'], {})
        entries.append(dict(jobId=row['job'], messageId=d['id'], reason=d.get('reason'), decidedAt=row['decided'],
                            role=m.get('role'), site=m.get('site'), collectedAt=m.get('collectedAt'),
                            text=apply_rules(str(m.get('text', '')))[0]))
    return entries


def privacy_list(pipeline, limit=MAX_EXCLUDED_LISTED):
    """privacy.list: held batches plus every message the gate or the user excluded, for the current team only.

    mixed_redacted messages are allowed, so they are not listed.
    """
    with connect(pipeline.db) as c:
        team_id = bound_team(c)
        held = [_held_batch_view(row) for row in c.execute(HELD_BATCHES, (team_id,)).fetchall()]
        decided = c.execute(DECIDED_BATCHES, (team_id,)).fetchall()
    excluded = [entry for row in decided for entry in _excluded_messages(row)]
    return dict(teamId=team_id, items=held, excluded=excluded[:limit], excludedCount=len(excluded))


def _record_exclusions(c, job, params, detail):
    """Exclude the named message, or every message the gate did not allow."""
    targets = [params['messageId']] if 'messageId' in params else [d['id'] for d in detail if d['decision'] != ALLOW]
    if not targets or any(t not in {d['id'] for d in detail} for t in targets):
        raise ValueError('제외할 발화를 확인하세요.')
    c.executemany('INSERT OR IGNORE INTO privacy_overrides VALUES(?,?,?,?)', [(job, t, 'exclude', time.time()) for t in targets])


def _check_request(params):
    if not isinstance(params.get('id'), str) or not isinstance(params.get('teamId'), str):
        raise ValueError('보류된 작업과 대상 팀을 확인하세요.')
    if 'messageId' in params and not isinstance(params['messageId'], str):
        raise ValueError('제외할 발화를 확인하세요.')


def _held_batch(c, params):
    """The batch params name, in the caller's write transaction; ValueError unless it is held for the current team."""
    team_id = bound_team(c)
    row = c.execute(HELD_BATCH, (params['id'], team_id)).fetchone()
    if not row or params['teamId'] != team_id:
        raise ValueError('현재 팀에 보류된 작업이 아닙니다.')
    return row


def _mark_requested(c, job, reason):
    # Still held (nothing is sent from here) until the next run writes a new decision; the screen shows it as pending.
    c.execute('UPDATE privacy_jobs SET reason=?,decided=? WHERE job=?', (reason, time.time(), job))


def exclude_messages(pipeline, params):
    """privacy.exclude: leave the named message, or every message the gate did not allow, out of the next run."""
    _check_request(params)
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        row = _held_batch(c, params)
        _record_exclusions(c, params['id'], params, json.loads(row['detail']))
        _mark_requested(c, params['id'], 'exclude_requested')
    return dict(queued=True)


def recheck_batch(pipeline, params):
    """privacy.recheck: forget the judging model's cached answers so the next run asks it again."""
    _check_request(params)
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        row = _held_batch(c, params)
        pipeline.privacy.forget_holds(c, json.loads(row['messages']), row['model'])
        _mark_requested(c, params['id'], 'recheck_requested')
    return dict(queued=True)
