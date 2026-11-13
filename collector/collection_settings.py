"""Collection settings of the turn pipeline: stored options and profile, the classifier context, collection.configure."""
from datetime import datetime
import json
import math
import re
import time

from ai.syncup_ai.schema import SUBTOPICS
from collection_session import bind_sharing, set_paused

CONFIGURABLE = {'teamId', 'projectTopic', 'enabledSubtopics', 'turnsPerBatch', 'endsAt', 'autoCollect', 'accountSync'}
MAX_TOPIC = 1200
MAX_BATCH_TURNS = 50
MAX_COLLECTION_SECONDS = 86400
# The ChatGPT account hash the extension sends: sha256 of the user id, lower-case hex (sync-contract.md 4).
SYNC_ACCOUNT = re.compile('[0-9a-f]{64}')


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


def _apply_account_sync(options, value):
    """accountSync {enabled, account?}, kept in the options as {enabled, account, since}.

    Turning on stores the account and the consent time (since), which stays when it is already on.
    Turning off clears since and keeps the account. The extension checks the account; the collector only stores it.
    """
    if not isinstance(value, dict) or set(value) - {'enabled', 'account'} or type(value.get('enabled')) is not bool:
        raise ValueError('동기화 설정 오류')
    state = options.get('accountSync')
    if not value['enabled']:
        if state:  # never turned on: stays None
            state.update(enabled=False, since=None)
        return
    if not isinstance(value.get('account'), str) or not SYNC_ACCOUNT.fullmatch(value['account']):
        raise ValueError('동기화 계정 오류')
    since = state['since'] if state and state['enabled'] else time.time()
    options['accountSync'] = dict(enabled=True, account=value['account'], since=since)


def _whole_ms(seconds, up):
    """seconds moved to a whole millisecond (up or down), the precision of the ISO times the extension compares."""
    micro = round(seconds * 1_000_000)
    return (-(-micro // 1000) if up else micro // 1000) / 1000


def sync_windows(c, session):
    """The account sync windows, (start, end) Unix seconds in start order, each half-open [start, end).

    [max(session start, since), settings end) minus every pause (one without an end runs on); [] while sync is off.
    Bounds move inward to whole milliseconds, so the tab and turns.append judge a turn at a boundary alike.
    """
    state = read_options(c).get('accountSync')
    if not state or not state['enabled']:
        return []
    pieces = [(max(session['start'], state['since']), session['end'])]
    for pause_start, pause_end in c.execute('SELECT start,end FROM pauses ORDER BY start').fetchall():
        pause_end = math.inf if pause_end is None else pause_end
        pieces = [(a, b) for start, end in pieces
                  for a, b in ((start, min(end, pause_start)), (max(start, pause_end), end)) if a < b]
    windows = [(_whole_ms(start, True), _whole_ms(end, False)) for start, end in sorted(pieces)]
    return [(start, end) for start, end in windows if start < end]


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
    with pipeline.write() as c:
        options = read_options(c)
        if 'teamId' in patch:
            bind_sharing(c, pipeline.client, patch['teamId'], profile)
            options['profile'] = profile
        _apply_options(options, patch)
        if 'accountSync' in patch:
            _apply_account_sync(options, patch['accountSync'])
        if 'endsAt' in patch:
            _set_end(c, patch['endsAt'])
        if 'autoCollect' in patch:
            if type(patch['autoCollect']) is not bool:
                raise ValueError('수집 상태 오류')
            set_paused(c, not patch['autoCollect'])
        write_options(c, options)
