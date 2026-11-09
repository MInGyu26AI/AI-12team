"""Batch classification: each queued batch passes the on-device privacy gate, then the external AI, and its cards
become private candidates. Failures keep the batch for jobs.retry."""
import json

from ai.syncup_ai.classify import handle_request as classify
from batch_queue import previous_batch_tail
from card_contract import KIND_OF_TAG, PUBLIC_FIELDS, validate_card
from collection_session import require_active
from diagnostics import failure
from local_privacy import ALLOW, EXCLUDE, HOLD
from outbound_guard import OutboundGuard, blocked_reason
from stable_ids import digest
from storage import connect

QUEUED_BATCHES = '''SELECT j.id,x.team_id,x.context,x.messages FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE j.state='new' ORDER BY j.rowid'''
# A team's batches whose classification failed, waiting for jobs.retry. Param: team id (and job id for FAILED_BATCH).
FAILED_BATCHES = '''SELECT j.id,j.detail FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE x.team_id=? AND j.state='failed_new' '''
FAILED_BATCH = '''SELECT x.context FROM job_context x JOIN jobs j ON j.id=x.job
    WHERE x.team_id=? AND x.job=? AND j.state='failed_new' '''
# Pipeline cards are never 'adoption unconfirmed': v2 packets carry the tag's label only (card_contract.validate_v2).
ADOPTED = 1


def classify_queued(pipeline):
    """Classify every queued batch once. Runs without pipeline.lock, so configure() can run during an AI call: the
    privacy review and the AI call run outside any transaction, and every write re-checks require_active under
    BEGIN IMMEDIATE."""
    if not pipeline.process_lock.acquire(blocking=False):
        return
    try:
        with connect(pipeline.db) as c:
            jobs = c.execute(QUEUED_BATCHES).fetchall()
        for job in jobs:
            context = json.loads(job['context'])
            # Outside _classify_batch's error handling: a database error here aborts the whole run.
            if _runnable(pipeline, job, context):
                _classify_batch(pipeline, job, context)
    finally:
        pipeline.process_lock.release()


def _runnable(pipeline, job, context):
    """False when the batch's session or team is no longer current, or it waits for a local privacy decision."""
    try:
        require_active(pipeline.db, job['team_id'], context['collectionStart'])
    except ValueError:
        return False
    with connect(pipeline.db) as c:
        return not pipeline.privacy.waiting(c, job['id'])


def _classify_batch(pipeline, job, context):
    try:
        messages = json.loads(job['messages'])
        earlier_job, earlier = previous_batch_tail(pipeline.db, job, context, messages)
        # Batch, earlier context and metadata all pass the on-device gate before any AI client exists.
        review = pipeline.privacy.review_job(pipeline.db, job['id'], messages, earlier, context, earlier_job)
        if review.decision == HOLD:
            return
        if review.decision == EXCLUDE:
            _exclude_locally(pipeline, job, context)
            return
        llm, decider = _guarded_clients(pipeline, job, context, review)
        request = dict(context=review.context, messages=review.messages, contextMessages=review.context_messages)
        result = classify(request, llm, decider)
        blocked = llm.blocked or (decider.blocked if decider else None)
        if blocked:
            _hold_blocked(pipeline, job, review, blocked)
            return
        if not result['ok']:
            raise ValueError(result['error'])
        _store_cards(pipeline, job, context, result)
    except Exception as error:
        _mark_failed(pipeline, job, context, error)


def _exclude_locally(pipeline, job, context):
    # Lock (BEGIN IMMEDIATE) -> re-check (require_active) -> mark done only while still 'new'. On failure nothing is
    # written and the error reaches _mark_failed.
    with connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        require_active(pipeline.db, job['team_id'], context['collectionStart'])
        c.execute("UPDATE jobs SET state='done',detail='개인 내용 · 로컬에서 제외, 외부 전송 없음' WHERE id=? AND state='new'",
                  (job['id'],))


def _guarded_clients(pipeline, job, context, review):
    """AI clients that re-check the session before each request and refuse text the local review did not clear."""
    llm, decider = pipeline.llm_factory(), pipeline.decider_factory()
    guard = lambda: require_active(pipeline.db, job['team_id'], context['collectionStart'])
    llm.before_request = guard
    if decider:
        decider.before_request = guard
    guarded_decider = OutboundGuard(decider, review.fragments) if decider else None
    return OutboundGuard(llm, review.fragments), guarded_decider


def _hold_blocked(pipeline, job, review, reason):
    """Nothing was sent. Allowed messages that carry a blocked piece become holds, so the user can exclude them."""
    detail = []
    for entry in review.detail:
        if entry['decision'] == ALLOW and blocked_reason(entry['sanitized'], review.fragments):
            entry = dict(entry, decision=HOLD, reason=reason, sanitized=None)
        detail.append(entry)
    pipeline.privacy.record(pipeline.db, job['id'], HOLD, reason, review.model, detail)


def _store_cards(pipeline, job, context, result):
    # On failure the transaction rolls back: no card is stored and the job stays 'new' for _mark_failed.
    with connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        require_active(pipeline.db, job['team_id'], context['collectionStart'])
        # Ids use the position in the unfiltered result; filtering first would change them and break dedup.
        for index, card in enumerate(result['cards']):
            if card['relevance'] == 'related' and card['tag'] != 'none':
                _store_card(c, job, digest([job['id'], index]), card)
        c.execute("UPDATE jobs SET state='done',detail='' WHERE id=?", (job['id'],))


def _store_card(c, job, identifier, card):
    validate_card({k: card[k] for k in PUBLIC_FIELDS})
    c.execute('''INSERT INTO cards(id,job,kind,adopted,draft,quote,role,status) VALUES(?,?,?,?,?,?,?,'ready')
                 ON CONFLICT(id) DO NOTHING''',
              (identifier, job['id'], KIND_OF_TAG[card['tag']], ADOPTED, card['content'], card['sentence'], card['evidence']['role']))
    c.execute('INSERT INTO candidate_details VALUES(?,?,?,0) ON CONFLICT(id) DO NOTHING',
              (identifier, job['team_id'], json.dumps(card, ensure_ascii=False)))


def _mark_failed(pipeline, job, context, error):
    # Implicit transaction, no BEGIN IMMEDIATE. Check (require_active) -> mark failed_new; job_context keeps the messages
    # for jobs.retry. If the check fails (paused, ended, or session/team changed), the job is left 'new' untouched.
    failure('classification', error, job['id'])
    try:
        require_active(pipeline.db, job['team_id'], context['collectionStart'])
    except ValueError:
        return
    with connect(pipeline.db) as c:
        c.execute("UPDATE jobs SET state='failed_new',detail=? WHERE id=?",
                  ('분류 실패 · ' + type(error).__name__ + ' · 원문 보존, 재시도 가능', job['id']))


def failed_batches(c, team_id):
    return [dict(r) for r in c.execute(FAILED_BATCHES, (team_id,))]


def retry_failed(pipeline, params):
    """jobs.retry: queue a failed batch again in the current session (local_rpc has validated id and teamId)."""
    with pipeline.write() as c:
        s, binding = require_active(pipeline.db, params.get('teamId'))
        row = c.execute(FAILED_BATCH, (binding['team_id'], params['id'])).fetchone()
        if not row:
            raise ValueError('재시도할 작업이 없습니다.')
        context = json.loads(row[0])
        context['collectionStart'] = s['start']
        c.execute('UPDATE job_context SET context=? WHERE job=?', (json.dumps(context), params['id']))
        c.execute("UPDATE jobs SET state='new',detail='' WHERE id=? AND state='failed_new'", (params['id'],))
    return dict(queued=True)
