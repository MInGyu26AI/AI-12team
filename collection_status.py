"""collection.status: what the extension popup and the web show about the current collection session."""
from datetime import datetime, timezone
import json
import time

from ai.syncup_ai.batch import group_turns
from collection_settings import local_profile, read_options
from collector import active
import local_privacy
from storage import connect
from turn_intake import unresolved_issues

# Params for the next three: team id (and the session start for PENDING_BATCHES).
PENDING_BATCHES = '''SELECT count(*) FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE x.team_id=? AND j.state='new' AND json_extract(x.context,'$.collectionStart')=?
    AND j.id NOT IN (SELECT job FROM privacy_jobs WHERE decision='hold')'''
HELD_BATCHES = '''SELECT count(*) FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE x.team_id=? AND j.state='new' AND j.id IN (SELECT job FROM privacy_jobs WHERE decision='hold')'''
EXCLUDED_BATCHES = '''SELECT count(*) FROM privacy_jobs p JOIN job_context x ON x.job=p.job
    WHERE x.team_id=? AND p.decision='exclude' '''
FAILED_BATCHES = '''SELECT j.id,j.detail FROM jobs j JOIN job_context x ON x.job=j.id
    WHERE x.team_id=? AND j.state='failed_new' '''
CANDIDATE_STATES = '''SELECT c.status,o.state,count(*) AS n FROM candidate_details d JOIN cards c ON c.id=d.id
    LEFT JOIN outbox o ON o.id=c.id WHERE d.team_id=? AND NOT d.dismissed GROUP BY c.status,o.state'''
UNBATCHED_TURNS = '''SELECT conversation,message FROM intake WHERE team_id=? AND job IS NULL
    AND json_extract(message,'$.session')=? ORDER BY rowid'''
LAST_COLLECTED = "SELECT MAX(received) FROM intake WHERE team_id=? AND json_extract(message,'$.session')=?"
RECENT_BATCHES = '''SELECT x.job,x.context,x.messages,MAX(i.received) AS received FROM job_context x
    JOIN jobs j ON j.id=x.job JOIN intake i ON i.job=x.job
    WHERE x.team_id=? AND j.state='done' GROUP BY x.job ORDER BY received DESC LIMIT 20'''
# Cards the legacy collector drafted before the pipeline existed.
LEGACY_CANDIDATES = "SELECT count(*) FROM cards WHERE status IN ('manual','ready') AND id NOT IN (SELECT id FROM candidate_details)"


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _state(settings):
    if time.time() >= settings['end']:
        return 'ended'
    if settings['paused']:
        return 'paused'
    return 'collecting'


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


def _counts(c, team_id, start, failures, issues):
    return dict(_candidate_counts(c, team_id),
                classificationPending=c.execute(PENDING_BATCHES, (team_id, start)).fetchone()[0],
                classificationFailed=len(failures),
                intakeIssues=len(issues),
                privacyHeld=c.execute(HELD_BATCHES, (team_id,)).fetchone()[0],
                privacyExcluded=c.execute(EXCLUDED_BATCHES, (team_id,)).fetchone()[0])


def _buffered_turns(c, team_id, start):
    """Turns stored this session that no batch has taken yet."""
    conversations = {}
    for row in c.execute(UNBATCHED_TURNS, (team_id, start)):
        conversations.setdefault(row['conversation'], []).append(json.loads(row['message']))
    return sum(len(group_turns(messages)) for messages in conversations.values())


def _recent_batches(c, team_id):
    recent = []
    for row in c.execute(RECENT_BATCHES, (team_id,)).fetchall():
        messages = json.loads(row['messages'])
        recent.append(dict(id=row['job'], at=_iso(row['received']), site=messages[0]['site'],
                           turns=len(group_turns(messages)), trigger=json.loads(row['context']).get('trigger', 'auto'),
                           cardIds=[r[0] for r in c.execute('SELECT id FROM cards WHERE job=?', (row['job'],))]))
    return recent


def _privacy_state(gate):
    state = gate.last_state
    return dict(policy=local_privacy.POLICY_VERSION, model=state['model'], available=state['available'], reason=state['reason'])


def collection_status(pipeline):
    with connect(pipeline.db) as c:
        profile = local_profile(c)
        s = dict(c.execute('SELECT * FROM settings').fetchone())
        team_id = c.execute('SELECT team_id FROM sharing').fetchone()[0]
        options = read_options(c)
        buffered = _buffered_turns(c, team_id, s['start'])
        last_collected = c.execute(LAST_COLLECTED, (team_id, s['start'])).fetchone()[0]
        failures = [dict(r) for r in c.execute(FAILED_BATCHES, (team_id,))]
        issues = unresolved_issues(c, team_id, 'id,reason,received')
        counts = _counts(c, team_id, s['start'], failures, issues)
        legacy = c.execute(LEGACY_CANDIDATES).fetchone()[0]
        recent = _recent_batches(c, team_id)
    team = next((t for t in profile['teams'] if t['id'] == team_id), None)
    return dict(
        version='1',
        configured=bool(team),
        autoCollect=active(s),
        state=_state(s),
        turnsPerBatch=options['turnsPerBatch'],
        bufferedTurns=buffered,
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
    )
