"""collection.status: what the extension popup and the web show about the current collection session."""
from datetime import datetime, timezone
import json

from ai.syncup_ai.batch import group_turns, take_ready_batches
from collection_settings import local_profile, read_options, sync_windows
from batch_classification import failed_batches
from batch_queue import unbatched_turns
from collection_session import active, bound_team, session_state
import local_privacy
from storage import connect
from turn_intake import unresolved_issues

# Counts for collection.status. Params: team id (and the session start for PENDING_COUNT).
PENDING_COUNT = '''SELECT count(*) FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE x.team_id=? AND j.state='new' AND json_extract(x.context,'$.collectionStart')=?
    AND j.id NOT IN (SELECT job FROM privacy_jobs WHERE decision='hold')'''
HELD_COUNT = '''SELECT count(*) FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE x.team_id=? AND j.state='new' AND j.id IN (SELECT job FROM privacy_jobs WHERE decision='hold')'''
EXCLUDED_COUNT = '''SELECT count(*) FROM privacy_jobs p JOIN job_context x ON x.job=p.job
    WHERE x.team_id=? AND p.decision='exclude' '''
CANDIDATE_STATES = '''SELECT c.status,o.state,count(*) AS n FROM candidate_details d JOIN cards c ON c.id=d.id
    LEFT JOIN outbox o ON o.id=c.id WHERE d.team_id=? AND NOT d.dismissed GROUP BY c.status,o.state'''
LAST_COLLECTED = "SELECT MAX(received) FROM intake WHERE team_id=? AND json_extract(message,'$.session')=?"
RECENT_BATCHES = '''SELECT x.job,x.context,x.messages,MAX(i.received) AS received FROM job_context x
    JOIN jobs j ON j.id=x.job JOIN intake i ON i.job=x.job
    WHERE x.team_id=? AND j.state='done' GROUP BY x.job ORDER BY received DESC LIMIT 20'''
# Cards the legacy collector drafted before the pipeline existed.
LEGACY_CANDIDATE_COUNT = '''SELECT count(*) FROM cards WHERE status IN ('manual','ready')
    AND id NOT IN (SELECT id FROM candidate_details)'''


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _candidate_counts(c, team_id):
    counts = dict(reviewPending=0, deliveryPending=0, deliveryBlocked=0)
    for row in c.execute(CANDIDATE_STATES, (team_id,)):
        if row['status'] == 'ready':
            counts['reviewPending'] += row['n']
        elif row['state'] == 'pending':
            counts['deliveryPending'] += row['n']
        elif row['state'] == 'blocked':
            counts['deliveryBlocked'] += row['n']
    return counts


def _counts(c, team_id, start, failed, issues):
    return dict(_candidate_counts(c, team_id),
                classificationPending=c.execute(PENDING_COUNT, (team_id, start)).fetchone()[0],
                classificationFailed=failed,
                intakeIssues=issues,
                privacyHeld=c.execute(HELD_COUNT, (team_id,)).fetchone()[0],
                privacyExcluded=c.execute(EXCLUDED_COUNT, (team_id,)).fetchone()[0])


def _turn_counts(c, team_id, start):
    """(bufferedTurns, nextBatchTurns) of this session's turns that no batch has taken yet.

    bufferedTurns: every stored turn. nextBatchTurns: answered turns of the conversation closest to its next batch.
    Batches are cut per conversation and an unanswered last question waits, so the two differ;
    take_ready_batches with one turn per batch returns exactly the answered turns.
    """
    conversations = unbatched_turns(c, team_id, start).values()
    buffered = sum(len(group_turns(messages)) for messages in conversations)
    next_batch = max((len(take_ready_batches(messages, 1)[0]) for messages in conversations), default=0)
    return buffered, next_batch


def _recent_batches(c, team_id):
    recent = []
    for row in c.execute(RECENT_BATCHES, (team_id,)).fetchall():
        messages = json.loads(row['messages'])
        recent.append(dict(id=row['job'], at=_iso(row['received']), site=messages[0]['site'],
                           turns=len(group_turns(messages)), trigger=json.loads(row['context']).get('trigger', 'auto'),
                           cardIds=[r[0] for r in c.execute('SELECT id FROM cards WHERE job=?', (row['job'],))]))
    return recent


def _account_sync(state):
    """{enabled, account, since} with since as ISO; None when account sync was never turned on."""
    if not state:
        return None
    return dict(state, since=_iso(state['since']) if state['since'] is not None else None)


def _privacy_state(gate):
    state = gate.last_state
    return dict(policy=local_privacy.POLICY_VERSION, model=state['model'], available=state['available'], reason=state['reason'])


def collection_status(pipeline):
    with connect(pipeline.db) as c:
        profile = local_profile(c)
        s = dict(c.execute('SELECT * FROM settings').fetchone())
        team_id = bound_team(c)
        options = read_options(c)
        buffered, next_batch = _turn_counts(c, team_id, s['start'])
        last_collected = c.execute(LAST_COLLECTED, (team_id, s['start'])).fetchone()[0]
        failures = failed_batches(c, team_id)
        issues = [dict(id=i['id'], reason=i['reason'], received=i['received']) for i in unresolved_issues(c, team_id)]
        counts = _counts(c, team_id, s['start'], len(failures), len(issues))
        legacy = c.execute(LEGACY_CANDIDATE_COUNT).fetchone()[0]
        recent = _recent_batches(c, team_id)
        windows = sync_windows(c, s)
    team = next((t for t in profile['teams'] if t['id'] == team_id), None)
    return dict(
        version='1',
        configured=bool(team),
        autoCollect=active(s),
        state=session_state(s),
        turnsPerBatch=options['turnsPerBatch'],
        bufferedTurns=buffered,
        nextBatchTurns=next_batch,
        endsAt=_iso(s['end']),
        lastCollectedAt=_iso(last_collected) if last_collected is not None else None,
        teamId=team_id,
        teamName=team['name'] if team else '접근 불가',
        userName=profile['name'],
        teams=profile['teams'],
        projectTopic=options['projectTopic'],
        project=s['project'],
        failedJobs=failures,
        legacyCandidates=legacy,
        lastClassifier='native' if recent else None,
        recent=recent,
        profileStatus='cached',
        intakeIssues=issues,
        privacy=_privacy_state(pipeline.privacy),
        counts=counts,
        syncWindows=[dict(start=_iso(start), end=_iso(end)) for start, end in windows],
        accountSync=_account_sync(options.get('accountSync')),
    )
