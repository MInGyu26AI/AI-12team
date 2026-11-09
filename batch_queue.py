"""Batch queue: group stored turns per conversation into batches and queue each as a classification job."""
import json

from ai.syncup_ai.batch import context_tail, take_ready_batches
from collection_session import require_active
from collection_settings import classification_context, local_profile, read_options
from stable_ids import digest
from storage import connect

UNBATCHED = '''SELECT rowid,* FROM intake WHERE team_id=? AND job IS NULL
    AND json_extract(message,'$.session')=? ORDER BY rowid'''
# The latest batch queued before a job for the same team, session, conversation and site.
# Params: team, job id, session start, conversation, site.
PREVIOUS_BATCH = '''SELECT x.job,x.messages FROM job_context x JOIN jobs j ON j.id=x.job
    WHERE x.team_id=? AND j.rowid<(SELECT rowid FROM jobs WHERE id=?)
    AND json_extract(x.context,'$.collectionStart')=?
    AND json_extract(x.messages,'$[0].conversationId')=?
    AND json_extract(x.messages,'$[0].site')=? ORDER BY j.rowid DESC LIMIT 1'''


def queue_batch(c, batch, team_id, context):
    identifier = 'batch-' + digest([m['intakeId'] for m in batch])
    evidence = [dict(n=i, role=m['role'], text=m['text'], source=m['site']) for i, m in enumerate(batch, 1)]
    c.execute("INSERT INTO jobs VALUES(?,?,'new','')", (identifier, json.dumps(evidence, ensure_ascii=False)))
    c.execute('INSERT INTO job_context VALUES(?,?,?,?)',
              (identifier, team_id, json.dumps(context, ensure_ascii=False), json.dumps(batch, ensure_ascii=False)))
    c.executemany('UPDATE intake SET job=? WHERE id=?', [(identifier, m['intakeId']) for m in batch])


def queue_ready_batches(c, team_id, context, flush=False):
    """Queue every full batch of this session's unbatched turns; flush also queues what is left."""
    turns_per_batch = read_options(c)['turnsPerBatch']
    conversations = {}
    for r in c.execute(UNBATCHED, (team_id, context['collectionStart'])).fetchall():
        conversations.setdefault(r['conversation'], []).append(dict(json.loads(r['message']), intakeId=r['id']))
    trigger = 'flush' if flush else 'auto'
    for messages in conversations.values():
        ready, _ = take_ready_batches(messages, turns_per_batch, flush)
        for batch in ready:
            queue_batch(c, batch, team_id, dict(context, trigger=trigger))


def flush(pipeline):
    """collection.flush: queue the open batches now, however few turns they have."""
    with pipeline.write() as c:
        _, binding = require_active(pipeline.db)
        team_id = binding['team_id']
        queue_ready_batches(c, team_id, classification_context(c, team_id, local_profile(c)), True)
    return dict(queued=True)


def previous_batch_tail(db, job, context, messages):
    """(job id, last turns) of the batch queued just before this one in the same conversation and session.

    (None, []) for the first batch. The tail goes to the classifier as reference context only.
    """
    with connect(db) as c:
        previous = c.execute(PREVIOUS_BATCH, (job['team_id'], job['id'], context['collectionStart'],
                                              messages[0]['conversationId'], messages[0]['site'])).fetchone()
    if not previous:
        return None, []
    return previous['job'], context_tail(json.loads(previous['messages']))
