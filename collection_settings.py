"""Collection settings of the turn pipeline: stored options and profile, the active-session check, collection.configure."""
from datetime import datetime
import json
import math
import time

from ai.syncup_ai.schema import SUBTOPICS
from collector import active, set_paused
from storage import connect
from team_client import bind_sharing

CONFIGURABLE = {'teamId', 'projectTopic', 'enabledSubtopics', 'turnsPerBatch', 'endsAt', 'autoCollect'}
MAX_TOPIC = 1200
MAX_BATCH_TURNS = 50
MAX_COLLECTION_SECONDS = 86400


def read_options(c):
    return json.loads(c.execute('SELECT config FROM integration_settings').fetchone()[0])


def write_options(c, options):
    c.execute('UPDATE integration_settings SET config=?', (json.dumps(options, ensure_ascii=False),))


def cache_profile(c, profile):
    """Keep the team server's profile for display and classification context; sharing always re-authenticates."""
    options = read_options(c)
    options['profile'] = profile
    write_options(c, options)


def local_profile(c):
    """The cached profile, or one built from the binding when the team server was never reached."""
    profile = read_options(c).get('profile')
    if profile:
        return profile
    binding = c.execute('SELECT * FROM sharing').fetchone()
    return dict(user_id=binding['user_id'], name=binding['user_id'],
                teams=[dict(id=binding['team_id'], name=binding['team_id'])])


def require_active(db, team=None, start=None):
    """(settings, binding) while collection runs for this team and session; ValueError otherwise."""
    with connect(db) as c:
        s = c.execute('SELECT * FROM settings').fetchone()
        binding = c.execute('SELECT * FROM sharing').fetchone()
        if not active(s):
            raise ValueError('수집이 일시중지되었거나 종료되었습니다.')
        team_changed = not binding or not binding['team_id'] or (team and binding['team_id'] != team)
        if team_changed or (start is not None and start != s['start']):
            raise ValueError('수집 세션이나 대상 팀이 변경되었습니다.')
        return dict(s), dict(binding)


def classification_context(c, team_id, profile):
    """What the classifier is told about the team and session; stored with every batch."""
    team = next((t for t in profile['teams'] if t['id'] == team_id), None)
    if not team:
        raise ValueError('현재 팀의 구성원이 아닙니다.')
    options = read_options(c)
    keys = [json.loads(r[0]).get('topic_key') for r in c.execute('SELECT body FROM candidate_details WHERE team_id=?', (team_id,))]
    return dict(teamName=team['name'], userName=profile['name'], projectTopic=options['projectTopic'],
                enabledSubtopics=options['enabledSubtopics'], existingTopicKeys=list(set(k for k in keys if k)),
                collectionStart=c.execute('SELECT start FROM settings').fetchone()[0])


def _apply_options(options, patch):
    if 'projectTopic' in patch:
        if not isinstance(patch['projectTopic'], str) or len(patch['projectTopic']) > MAX_TOPIC:
            raise ValueError('프로젝트 주제 오류')
        options['projectTopic'] = patch['projectTopic']
    if 'turnsPerBatch' in patch:
        if type(patch['turnsPerBatch']) is not int or not 1 <= patch['turnsPerBatch'] <= MAX_BATCH_TURNS:
            raise ValueError('묶음 크기 오류')
        options['turnsPerBatch'] = patch['turnsPerBatch']
    if 'enabledSubtopics' in patch:
        if not isinstance(patch['enabledSubtopics'], list) or any(k not in SUBTOPICS for k in patch['enabledSubtopics']):
            raise ValueError('소주제 오류')
        options['enabledSubtopics'] = patch['enabledSubtopics']


def _set_end(c, value):
    """New end time within 24 hours; time spent after an earlier end is recorded as a pause."""
    end = datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    now = time.time()
    if not math.isfinite(end) or not now < end <= now + MAX_COLLECTION_SECONDS:
        raise ValueError('종료는 현재부터 24시간 이내로 설정하세요.')
    previous = c.execute('SELECT end FROM settings').fetchone()[0]
    if previous <= time.time():
        c.execute('INSERT INTO pauses(start,end) VALUES(?,?)', (previous, time.time()))
    c.execute('UPDATE settings SET end=?', (end,))


def configure(pipeline, patch):
    """collection.configure; the caller reports collection_status afterwards."""
    if not isinstance(patch, dict) or set(patch) - CONFIGURABLE:
        raise ValueError('수집 설정 필드 오류')
    # me() is a network call, so it runs before taking the lock.
    profile = pipeline.client.me() if 'teamId' in patch else None
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        options = read_options(c)
        if 'teamId' in patch:
            bind_sharing(c, pipeline.client, patch['teamId'], profile)
            options['profile'] = profile
        _apply_options(options, patch)
        if 'endsAt' in patch:
            _set_end(c, patch['endsAt'])
        if 'autoCollect' in patch:
            if type(patch['autoCollect']) is not bool:
                raise ValueError('수집 상태 오류')
            set_paused(c, not patch['autoCollect'])
        write_options(c, options)
