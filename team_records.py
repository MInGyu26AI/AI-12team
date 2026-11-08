"""Authenticated team projections, durable conflict checks and append-only resolution history."""
import threading
import time
from urllib.parse import unquote

from psycopg.types.json import Jsonb

from ai.syncup_ai.conflict import handle_request as check_conflicts, _is_decision
from ai.syncup_ai.llm import from_env, decider_from_env, LLMNotConfigured, RetryableLLMError
from card_contract import board_card
from diagnostics import failure, check_started, check_finished, model_fingerprint, conflict_policy_fingerprint

_running = set()
_lock = threading.Lock()
MAX_CHECK_ATTEMPTS = 3  # 최초 시도 + 일시적인 통신 실패 재시도 2회
CONFLICT_POLICY_SHA256 = conflict_policy_fingerprint()


def team_lock(c, team_id):
    c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (str(team_id),))


def enqueue(c, team_id, packet):
    if packet.get('version') != 2:
        return
    c.execute('INSERT INTO syncup.record_states(team_id,card_id) VALUES(%s,%s) ON CONFLICT DO NOTHING', (team_id, packet['id']))
    if packet['card']['tag'] == 'decision':
        c.execute('INSERT INTO syncup.conflict_checks(team_id,card_id) VALUES(%s,%s) ON CONFLICT DO NOTHING', (team_id, packet['id']))


def board(c, team_id, history=False):
    rows = c.execute('''SELECT r.packet,r.approved_by::text,r.approved_at,
        coalesce(s.state,'active') AS decision_state,coalesce(k.state,'not-required') AS check_state,
        coalesce(k.detail,'') AS check_detail
        FROM syncup.shared_cards r LEFT JOIN syncup.record_states s ON (s.team_id,s.card_id)=(r.team_id,r.id)
        LEFT JOIN syncup.conflict_checks k ON (k.team_id,k.card_id)=(r.team_id,r.id)
        WHERE r.team_id=%s ORDER BY r.received_at,r.id''', (team_id,)).fetchall()
    return [dict(board_card(r), decisionState=r['decision_state'], conflictCheckStatus=r['check_state'],
                 conflictCheckDetail=r['check_detail'])
            for r in rows if history or r['decision_state'] in ('active', 'review')]


def conflicts(c, team_id, history=False):
    rows = c.execute('SELECT * FROM syncup.conflicts WHERE team_id=%s ORDER BY id', (team_id,)).fetchall()
    return [dict(r['payload'], **({'resolution': r['resolution'], 'resolutionNote': r['note']} if r['resolution'] else {}))
            for r in rows if history or r['resolution'] in (None, 'discuss')]


def handle(c, team_id, user_id, method, tail, data):
    from team_server import AccessError
    if method == 'GET' and tail in (['board'], ['history']):
        return dict(team_id=str(team_id), items=board(c, team_id, tail == ['history']))
    if method == 'GET' and tail == ['conflicts']:
        return dict(team_id=str(team_id), conflicts=conflicts(c, team_id))
    if method == 'GET' and tail == ['todos', 'done']:
        return dict(team_id=str(team_id), ids=[r['card_id'] for r in c.execute(
            'SELECT card_id FROM syncup.todo_states WHERE team_id=%s AND done ORDER BY card_id', (team_id,))])
    if method == 'GET' and tail == ['conflicts', 'history']:
        events = c.execute('''SELECT conflict_id,actor::text,resolution,note,at::text
            FROM syncup.conflict_events WHERE team_id=%s ORDER BY id''', (team_id,)).fetchall()
        return dict(team_id=str(team_id), conflicts=conflicts(c, team_id, True), events=events)
    if method != 'POST' or not isinstance(data, dict):
        raise AccessError(404)
    team_lock(c, team_id)
    if len(tail) == 3 and tail[0] == 'conflicts' and tail[2] == 'resolve':
        if set(data) - {'resolution', 'resolutionNote'}:
            raise ValueError('해결 필드 오류')
        choice, note = data.get('resolution'), data.get('resolutionNote', '')
        if choice not in ('keep-existing', 'adopt-new', 'both-valid', 'discuss') or not isinstance(note, str) or len(note) > 1200:
            raise ValueError('해결 선택 오류')
        row = c.execute('SELECT * FROM syncup.conflicts WHERE team_id=%s AND id=%s FOR UPDATE', (team_id, unquote(tail[1]))).fetchone()
        if not row:
            raise AccessError(404)
        if row['resolution'] == choice and row['note'] == note:
            return dict(ok=True, team_id=str(team_id))
        if row['resolution'] not in (None, 'discuss'):
            raise AccessError(409)
        c.execute('UPDATE syncup.conflicts SET resolution=%s,note=%s WHERE team_id=%s AND id=%s', (choice,note,team_id,row['id']))
        c.execute('INSERT INTO syncup.conflict_events(team_id,conflict_id,actor,resolution,note) VALUES(%s,%s,%s,%s,%s)',
                  (team_id,row['id'],user_id,choice,note))
        loser = row['card_b'] if choice == 'keep-existing' else row['card_a'] if choice == 'adopt-new' else None
        if loser:
            state = 'rejected' if choice == 'keep-existing' else 'superseded'
            c.execute('UPDATE syncup.record_states SET state=%s WHERE team_id=%s AND card_id=%s', (state,team_id,loser))
            stale = c.execute('''UPDATE syncup.conflicts SET resolution='obsolete',note='관련 결정이 다른 해결에서 종료됨'
                WHERE team_id=%s AND (card_a=%s OR card_b=%s) AND (resolution IS NULL OR resolution='discuss') RETURNING id''',
                (team_id,loser,loser)).fetchall()
            for r in stale:
                c.execute('INSERT INTO syncup.conflict_events(team_id,conflict_id,actor,resolution,note) VALUES(%s,%s,%s,%s,%s)',
                          (team_id,r['id'],user_id,'obsolete','관련 결정이 다른 해결에서 종료됨'))
        c.execute('''UPDATE syncup.record_states s SET state=CASE WHEN EXISTS(
             SELECT 1 FROM syncup.conflicts x WHERE x.team_id=s.team_id AND x.card_b=s.card_id
             AND (x.resolution IS NULL OR x.resolution='discuss')) THEN 'review' ELSE 'active' END
             WHERE s.team_id=%s AND s.state IN ('active','review')''', (team_id,))
        return dict(ok=True, team_id=str(team_id))
    if len(tail) == 3 and tail[0] == 'items' and tail[2] == 'done':
        if set(data) != {'done'} or type(data['done']) is not bool:
            raise ValueError('완료 상태 오류')
        identifier = unquote(tail[1])
        row = c.execute('SELECT packet FROM syncup.shared_cards WHERE team_id=%s AND id=%s', (team_id,identifier)).fetchone()
        if not row or row['packet'].get('label') != '할 일':
            raise AccessError(404)
        c.execute('''INSERT INTO syncup.todo_states(team_id,card_id,done,actor) VALUES(%s,%s,%s,%s)
            ON CONFLICT(team_id,card_id) DO UPDATE SET done=excluded.done,actor=excluded.actor,at=clock_timestamp()''',
            (team_id,identifier,data['done'],user_id))
        return dict(ok=True, team_id=str(team_id))
    if len(tail) == 3 and tail[0] == 'items' and tail[2] == 'retry-check':
        row = c.execute('''UPDATE syncup.conflict_checks SET state='pending',attempts=0,next_attempt=now(),detail='',diagnostics='{}'::jsonb
            WHERE team_id=%s AND card_id=%s AND state='failed' RETURNING card_id''', (team_id,unquote(tail[1]))).fetchone()
        if not row:
            raise AccessError(409)
        return dict(ok=True, team_id=str(team_id))
    raise AccessError(404)


def process_checks(server, token, team_id):
    from team_server import authorized
    for _ in range(20):
        with authorized(server.dsn, token, team_id) as (c, _user):
            team_lock(c, team_id)
            c.execute("""UPDATE syncup.conflict_checks SET state='failed',detail='중단된 검사 · 수동 재시도 필요',
                diagnostics=diagnostics || jsonb_build_object('outcome','interrupted',
                    'finished_at',extract(epoch from clock_timestamp()),'checked_count',NULL,'elapsed_ms',NULL)
                WHERE team_id=%s AND state='running' AND next_attempt<=now()""", (team_id,))
            job = c.execute('''SELECT * FROM syncup.conflict_checks WHERE team_id=%s AND attempts<%s
                AND state='pending' AND next_attempt<=now()
                ORDER BY next_attempt,card_id LIMIT 1 FOR UPDATE''', (team_id,MAX_CHECK_ATTEMPTS)).fetchone()
            if not job:
                return
            row = c.execute('SELECT packet,approved_by::text,approved_at,received_at FROM syncup.shared_cards WHERE team_id=%s AND id=%s',
                            (team_id,job['card_id'])).fetchone()
            new = board_card(row)
            earlier = c.execute('''SELECT r.packet,r.approved_by::text,r.approved_at FROM syncup.shared_cards r
                LEFT JOIN syncup.record_states s ON (s.team_id,s.card_id)=(r.team_id,r.id)
                WHERE r.team_id=%s AND (r.received_at,r.id)<(%s,%s) AND coalesce(s.state,'active')='active' ''',
                (team_id,row['received_at'],job['card_id'])).fetchall()
            existing = [board_card(r) for r in earlier]
            candidate_ids = {card['id'] for card in existing if _is_decision(card) and card['id'] != new['id']}
            # 중단 후에도 시작 여부를 확인하도록 진단과 작업 상태를 같은 트랜잭션에 저장한다.
            diagnostic = check_started(job['attempts'] + 1, len(candidate_ids))
            lease = c.execute("UPDATE syncup.conflict_checks SET state='running',detail='',diagnostics=%s,attempts=attempts+1,next_attempt=clock_timestamp()+interval '3 minutes' WHERE team_id=%s AND card_id=%s RETURNING next_attempt",
                      (Jsonb(diagnostic),team_id,job['card_id'])).fetchone()['next_attempt']
        started = time.monotonic()
        try:
            if getattr(server, 'conflict_engine', None):
                result = server.conflict_engine(dict(newCards=[new], existing=existing))
            else:
                try:
                    llm = from_env()
                except LLMNotConfigured:
                    llm = None
                decider = decider_from_env()
                diagnostic.update(policy_sha256=CONFLICT_POLICY_SHA256,
                                  requested_models=dict(chat=model_fingerprint(llm), decisions=model_fingerprint(decider)))
                result = check_conflicts(dict(newCards=[new], existing=existing),
                                         llm, decider=decider, allow_rules=False)
        except Exception as error:
            failure('conflict_engine', error, job['card_id'])
            result = dict(ok=False, retryable=isinstance(error, RetryableLLMError),
                          failureReason='communication' if isinstance(error, RetryableLLMError) else 'check-failed')
        with authorized(server.dsn, token, team_id) as (c, _user):
            team_lock(c, team_id)
            current = c.execute('SELECT state,attempts,next_attempt FROM syncup.conflict_checks WHERE team_id=%s AND card_id=%s FOR UPDATE', (team_id,job['card_id'])).fetchone()
            if current['state'] != 'running' or current['attempts'] != job['attempts']+1 or current['next_attempt'] != lease:
                continue
            if not result.get('ok') or result.get('checkStatus') != 'complete':
                transient = result.get('retryable') is True and result.get('failureReason') == 'communication'
                retry = transient and current['attempts'] < MAX_CHECK_ATTEMPTS
                detail = ('확인 필요 · AI 판정 확신도 부족' if result.get('failureReason') == 'low-confidence' else
                          'AI 연결 오류 · 자동 재시도 대기' if retry else
                          'AI 연결 오류 · 자동 재시도 한도 도달' if transient else 'AI 검사 미완료 · 확인 필요')
                reason = result.get('failureReason')
                outcome = ('retry-pending' if retry else 'retry-exhausted') if transient else (
                    'needs-review' if reason == 'low-confidence' else 'check-failed')
                diagnostic = check_finished(diagnostic, result, new['id'], candidate_ids,
                                            (time.monotonic()-started)*1000, outcome)
                c.execute("UPDATE syncup.conflict_checks SET state=%s,detail=%s,diagnostics=%s,next_attempt=now()+interval '30 seconds' WHERE team_id=%s AND card_id=%s",
                          ('pending' if retry else 'failed',detail,Jsonb(diagnostic),team_id,job['card_id']))
                continue
            for conflict in result['conflicts']:
                a, b = conflict['cardA']['id'], conflict['cardB']['id']
                active = c.execute("SELECT card_id FROM syncup.record_states WHERE team_id=%s AND card_id IN (%s,%s) AND state IN ('active','review')", (team_id,a,b)).fetchall()
                if len(active) != 2:
                    continue
                c.execute('''INSERT INTO syncup.conflicts(team_id,id,card_a,card_b,payload) VALUES(%s,%s,%s,%s,%s)
                    ON CONFLICT DO NOTHING''', (team_id,conflict['id'],a,b,Jsonb(conflict)))
                c.execute("UPDATE syncup.record_states SET state='review' WHERE team_id=%s AND card_id=%s AND state='active'", (team_id,b))
            diagnostic = check_finished(diagnostic, result, new['id'], candidate_ids,
                                        (time.monotonic()-started)*1000, 'complete')
            c.execute("UPDATE syncup.conflict_checks SET state='complete',detail='',diagnostics=%s WHERE team_id=%s AND card_id=%s",
                      (Jsonb(diagnostic),team_id,job['card_id']))


def schedule(server, token, team_id):
    if getattr(server, 'disable_checks', False):
        return
    key = (id(server), str(team_id))
    with _lock:
        if key in _running:
            return
        _running.add(key)
    def run():
        try:
            process_checks(server, token, team_id)
        except Exception as error:
            failure('conflict_worker', error, team_id)
        finally:
            with _lock:
                _running.discard(key)
    threading.Thread(target=run, daemon=True).start()
