"""Durable conflict checks: a new decision is compared with every earlier live decision, one leased pair at a time.

The lease protocol stays in this one module: a pair is leased in one transaction, judged outside any
transaction, and recorded in a second transaction only while the same lease still holds.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
import time

from psycopg.types.json import Jsonb

from ai.syncup_ai.conflict import handle_request as check_conflicts, ordered_candidates
from ai.syncup_ai.llm import from_env, decider_from_env, LLMNotConfigured, RetryableLLMError
from card_contract import board_card
from diagnostics import (failure, check_started, check_finished, checked_count, model_fingerprint,
                         conflict_policy_fingerprint)
from team_access import AccessError, authorized, team_lock

MAX_CHECK_ATTEMPTS = 3  # 최초 시도 + 일시적인 통신 실패 재시도 2회
CHECK_SLICE_PAIRS = 30  # pairs one pass handles before the scheduler looks again; not a coverage limit
# A lease must outlast one judgement (CONFLICT_CHECK_SECONDS in ai/syncup_ai/config.py).
LEASE = timedelta(minutes=3)
RETRY_DELAY = timedelta(seconds=30)
CONFLICT_POLICY_SHA256 = conflict_policy_fingerprint()
SKIPPED_DETAIL = '비활성 결정 비교 제외'
# outcome of a pair that did not complete -> (check state, detail shown on the board)
FAILURES = {
    'retry-pending': ('pending', 'AI 연결 오류 · 자동 재시도 대기'),
    'retry-exhausted': ('failed', 'AI 연결 오류 · 자동 재시도 한도 도달'),
    'needs-review': ('failed', '확인 필요 · AI 판정 확신도 부족'),
    'check-failed': ('failed', 'AI 검사 미완료 · 확인 필요'),
}


@dataclass
class Lease:
    """A running pair: the new decision and the earlier one it is compared with (none for a first decision)."""
    new: dict
    existing: list
    progress: dict
    attempt: int
    expires: datetime
    diagnostic: dict

    @property
    def card_id(self):
        return self.new['id']

    @property
    def candidate_ids(self):
        return {card['id'] for card in self.existing}


def enqueue(c, team_id, packet):
    """Track a newly shared v2 card; decisions also wait for a check. Legacy-format packets are never tracked."""
    if packet.get('version') != 2:
        return
    c.execute('INSERT INTO syncup.record_states(team_id,card_id) VALUES(%s,%s) ON CONFLICT DO NOTHING',
              (team_id, packet['id']))
    if packet['card']['tag'] == 'decision':
        c.execute('INSERT INTO syncup.conflict_checks(team_id,card_id) VALUES(%s,%s) ON CONFLICT DO NOTHING',
                  (team_id, packet['id']))


def retry_check(c, team_id, card_id):
    """A member restarts a failed check from its checkpoint with a fresh attempt budget."""
    row = c.execute('''UPDATE syncup.conflict_checks
        SET state='pending',attempts=0,next_attempt=now(),detail='',diagnostics='{}'::jsonb
        WHERE team_id=%s AND card_id=%s AND state='failed' RETURNING card_id''', (team_id, card_id)).fetchone()
    if not row:
        raise AccessError(409)


def process_checks(server, token, team_id):
    """Advance this team's due checks by up to CHECK_SLICE_PAIRS pairs."""
    for _ in range(CHECK_SLICE_PAIRS):
        if server.checks_stop.is_set():
            return
        with authorized(server.dsn, token, team_id) as (c, _user):
            team_lock(c, team_id)
            _reclaim_expired(c, team_id)
            job = _next_job(c, team_id)
            if job is None:
                return
            lease = _lease_or_skip(c, team_id, job)
        if lease is None:
            continue
        started = time.monotonic()
        result = _judge(server, lease)
        with authorized(server.dsn, token, team_id) as (c, _user):
            team_lock(c, team_id)
            _record(c, team_id, lease, result, (time.monotonic() - started) * 1000)


def _reclaim_expired(c, team_id):
    """An expired lease means its worker stopped mid-pair: resume from the checkpoint with a fresh budget."""
    c.execute("""UPDATE syncup.conflict_checks SET state='pending',detail='중단된 검사 이어서 진행',attempts=0
        WHERE team_id=%s AND state='running' AND next_attempt<=now() AND progress ? 'ids'""", (team_id,))
    # Rows leased before checkpoints existed have no pair list to resume from, so a member must retry them.
    c.execute("""UPDATE syncup.conflict_checks SET state='failed',detail='중단된 검사 · 수동 재시도 필요',
        diagnostics=diagnostics || jsonb_build_object('outcome','interrupted',
            'finished_at',extract(epoch from clock_timestamp()),'checked_count',NULL,'elapsed_ms',NULL)
        WHERE team_id=%s AND state='running' AND next_attempt<=now() AND NOT (progress ? 'ids')""", (team_id,))


def _next_job(c, team_id):
    return c.execute('''SELECT * FROM syncup.conflict_checks WHERE team_id=%s AND attempts<%s
        AND state='pending' AND next_attempt<=now()
        ORDER BY next_attempt,card_id LIMIT 1 FOR UPDATE''', (team_id, MAX_CHECK_ATTEMPTS)).fetchone()


def _lease_or_skip(c, team_id, job):
    """Lease the job's next pair, or skip past pairs whose cards are no longer live decisions (returns None)."""
    row = c.execute('''SELECT packet,approved_by::text,approved_at,received_at FROM syncup.shared_cards
        WHERE team_id=%s AND id=%s''', (team_id, job['card_id'])).fetchone()
    new = board_card(row)
    progress, attempts = _checkpoint(c, team_id, job, row, new)
    ids, cursor = progress['ids'], progress['cursor']
    if _live_decision(c, team_id, new['id']) is None:
        _skip(c, team_id, new['id'], progress, len(ids) - cursor)
        return None
    existing = []
    if cursor < len(ids):
        earlier = _live_decision(c, team_id, ids[cursor])
        if earlier is None:
            _skip(c, team_id, new['id'], progress, 1)
            return None
        existing = [earlier]
    return _lease(c, team_id, new, existing, progress, attempts + 1)


def _checkpoint(c, team_id, job, row, new):
    """The saved pair list and attempt count; rebuilt from scratch when missing or made under another policy."""
    progress = job['progress']
    if progress and progress.get('policy') == CONFLICT_POLICY_SHA256:
        return progress, job['attempts']
    # Only cards with a decision state take part; legacy-format approvals have none and are never compared.
    earlier = c.execute('''SELECT r.packet,r.approved_by::text,r.approved_at FROM syncup.shared_cards r
        JOIN syncup.record_states s ON (s.team_id,s.card_id)=(r.team_id,r.id)
        WHERE r.team_id=%s AND (r.received_at,r.id)<(%s,%s) AND s.state IN ('active','review')''',
        (team_id, row['received_at'], job['card_id'])).fetchall()
    ids = [card['id'] for card in ordered_candidates(new, [board_card(r) for r in earlier])]
    # A policy change restarts the comparison with a fresh attempt budget.
    attempts = 0 if progress else job['attempts']
    return dict(ids=ids, cursor=0, skipped=0, policy=CONFLICT_POLICY_SHA256), attempts


def _live_decision(c, team_id, card_id):
    """The board card while it is an active or in-review decision, else None."""
    row = c.execute('''SELECT r.packet,r.approved_by::text,r.approved_at FROM syncup.shared_cards r
        JOIN syncup.record_states s ON (s.team_id,s.card_id)=(r.team_id,r.id)
        WHERE r.team_id=%s AND r.id=%s AND s.state IN ('active','review')''', (team_id, card_id)).fetchone()
    return board_card(row) if row else None


def _skip(c, team_id, card_id, progress, count):
    progress = dict(progress, cursor=progress['cursor'] + count, skipped=progress['skipped'] + count)
    state = 'complete' if progress['cursor'] == len(progress['ids']) else 'pending'
    c.execute('''UPDATE syncup.conflict_checks SET progress=%s,state=%s,attempts=0,next_attempt=now(),detail=%s
        WHERE team_id=%s AND card_id=%s''', (Jsonb(progress), state, SKIPPED_DETAIL, team_id, card_id))


def _lease(c, team_id, new, existing, progress, attempt):
    """Mark the pair running until LEASE ends; the start diagnostic is saved with it, so an interruption is visible."""
    diagnostic = check_started(attempt, len(existing))
    expires = c.execute('''UPDATE syncup.conflict_checks SET state='running',detail='',diagnostics=%s,progress=%s,
            attempts=%s,next_attempt=clock_timestamp()+%s
        WHERE team_id=%s AND card_id=%s RETURNING next_attempt''',
        (Jsonb(diagnostic), Jsonb(progress), attempt, LEASE, team_id, new['id'])).fetchone()['next_attempt']
    return Lease(new, existing, progress, attempt, expires, diagnostic)


def _judge(server, lease):
    """The engine's verdict on the leased pair; an exception or an incomplete answer becomes a failed result."""
    request = dict(newCards=[lease.new], existing=lease.existing)
    try:
        engine = getattr(server, 'conflict_engine', None)
        result = engine(request) if engine else _ai_judgement(request, lease.diagnostic)
    except Exception as error:
        failure('conflict_engine', error, lease.card_id)
        retryable = isinstance(error, RetryableLLMError)
        return dict(ok=False, retryable=retryable, failureReason='communication' if retryable else 'check-failed')
    if result.get('ok') and checked_count(result, lease.card_id, lease.candidate_ids) != len(lease.candidate_ids):
        return dict(ok=False, failureReason='check-failed')
    return result


def _ai_judgement(request, diagnostic):
    """Judge with the configured AI models; records the policy and model fingerprints into `diagnostic`."""
    try:
        llm = from_env()
    except LLMNotConfigured:
        llm = None
    decider = decider_from_env()
    # Recorded before the call, so a failed attempt still shows which policy and models it asked for.
    diagnostic.update(policy_sha256=CONFLICT_POLICY_SHA256,
                      requested_models=dict(chat=model_fingerprint(llm), decisions=model_fingerprint(decider)))
    return check_conflicts(request, llm, decider=decider, allow_rules=False)


def _record(c, team_id, lease, result, elapsed_ms):
    """Save the verdict unless the lease was lost: it expired and was leased again, or a member reset it."""
    current = c.execute('''SELECT state,attempts,next_attempt FROM syncup.conflict_checks
        WHERE team_id=%s AND card_id=%s FOR UPDATE''', (team_id, lease.card_id)).fetchone()
    if (current['state'], current['attempts'], current['next_attempt']) != ('running', lease.attempt, lease.expires):
        return
    if result.get('ok') and result.get('checkStatus') == 'complete':
        _record_success(c, team_id, lease, result, elapsed_ms)
    else:
        _record_failure(c, team_id, lease, result, elapsed_ms)


def _record_success(c, team_id, lease, result, elapsed_ms):
    for conflict in result['conflicts']:
        _save_alert(c, team_id, conflict)
    diagnostic = check_finished(lease.diagnostic, result, lease.card_id, lease.candidate_ids, elapsed_ms, 'complete')
    progress = dict(lease.progress, cursor=lease.progress['cursor'] + len(lease.existing))
    complete = progress['cursor'] == len(progress['ids'])
    # A finished check keeps its last attempt number; the next pair starts with a fresh budget.
    c.execute('''UPDATE syncup.conflict_checks SET state=%s,detail='',diagnostics=%s,progress=%s,attempts=%s,
            next_attempt=clock_timestamp()
        WHERE team_id=%s AND card_id=%s''',
        ('complete' if complete else 'pending', Jsonb(diagnostic), Jsonb(progress),
         lease.attempt if complete else 0, team_id, lease.card_id))


def _save_alert(c, team_id, conflict):
    """Keep an alert only while both cards are live decisions; its new card goes into review."""
    a, b = conflict['cardA']['id'], conflict['cardB']['id']
    live = c.execute('''SELECT card_id FROM syncup.record_states
        WHERE team_id=%s AND card_id IN (%s,%s) AND state IN ('active','review')''', (team_id, a, b)).fetchall()
    if len(live) != 2:
        return
    c.execute('''INSERT INTO syncup.conflicts(team_id,id,card_a,card_b,payload) VALUES(%s,%s,%s,%s,%s)
        ON CONFLICT DO NOTHING''', (team_id, conflict['id'], a, b, Jsonb(conflict)))
    c.execute("UPDATE syncup.record_states SET state='review' WHERE team_id=%s AND card_id=%s AND state='active'",
              (team_id, b))


def _record_failure(c, team_id, lease, result, elapsed_ms):
    outcome = _failure_outcome(result, lease.attempt)
    state, detail = FAILURES[outcome]
    diagnostic = check_finished(lease.diagnostic, result, lease.card_id, lease.candidate_ids, elapsed_ms, outcome)
    c.execute('''UPDATE syncup.conflict_checks SET state=%s,detail=%s,diagnostics=%s,next_attempt=now()+%s
        WHERE team_id=%s AND card_id=%s''', (state, detail, Jsonb(diagnostic), RETRY_DELAY, team_id, lease.card_id))


def _failure_outcome(result, attempt):
    """Only a retryable communication failure retries on its own; anything else waits for a member."""
    reason = result.get('failureReason')
    if result.get('retryable') is True and reason == 'communication':
        return 'retry-pending' if attempt < MAX_CHECK_ATTEMPTS else 'retry-exhausted'
    return 'needs-review' if reason == 'low-confidence' else 'check-failed'
