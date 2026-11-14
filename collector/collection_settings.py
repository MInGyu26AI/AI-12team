"""Collection settings of the turn pipeline: stored options and profile, the classifier context, collection.configure."""
from datetime import datetime
import json
import math
import re
import time
import urllib.error

from ai.syncup_ai.schema import SUBTOPICS
from collection_session import bind_sharing, bound_team, set_paused
from storage import connect

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


def _sharing_team(c):
    """bound_team, or None before the collector has a sharing binding at all."""
    return bound_team(c) if c.execute('SELECT 1 FROM sharing').fetchone() else None


def _team_settings(pipeline, team_id, data=None):
    """GET (data None) or POST teams/{id}/settings: the team's shared settings (server/team_settings.py).

    None when the team server predates team settings and answers 404, so an older server keeps working."""
    try:
        result = pipeline.client.request(f'teams/{team_id}/settings', data)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    settings = result.get('settings')
    if result.get('team_id') != team_id or not isinstance(settings, dict) or not isinstance(settings.get('topic'), str):
        raise ValueError('팀 설정 응답 오류')
    return settings


def _share_topic(pipeline, patch):
    """A changed projectTopic goes to the team first, so every member's collector follows it (sync_team_topic).

    Nothing is saved locally when the team server refuses it, so the members never drift apart silently."""
    topic = patch['projectTopic']
    if not isinstance(topic, str) or len(topic) > MAX_TOPIC:
        raise ValueError('프로젝트 주제 오류')
    with connect(pipeline.db) as c:
        team_id = patch['teamId'] if isinstance(patch.get('teamId'), str) else _sharing_team(c)
        current = read_options(c).get('projectTopic', '')
    if not team_id or topic.strip() == current.strip():
        return
    try:
        _team_settings(pipeline, team_id, {'topic': topic.strip()})
    except (OSError, ValueError):
        raise ValueError('팀 서버에 프로젝트 주제를 저장하지 못했습니다. 팀 서버 연결을 확인하세요.') from None


def sync_team_topic(pipeline):
    """Follow the team's shared project topic; the collection loop calls it every few seconds.

    A team where no member has saved settings yet takes this collector's topic, so a topic set before team
    settings existed becomes the team's. A topic the team cleared on purpose stays cleared.
    Returns the topic in use, or None with no team or a team server without team settings."""
    with connect(pipeline.db) as c:
        team_id = _sharing_team(c)
        local = read_options(c).get('projectTopic', '')
    if not team_id:
        return None
    settings = _team_settings(pipeline, team_id)
    if settings is None:
        return None
    if settings.get('updatedAt') is None:
        if local.strip():
            _team_settings(pipeline, team_id, {'topic': local.strip()})
        return local
    if settings['topic'] != local:
        with pipeline.write() as c:
            options = read_options(c)
            options['projectTopic'] = settings['topic']
            write_options(c, options)
    return settings['topic']


def configure(pipeline, patch):
    """collection.configure; the caller reports collection_status afterwards."""
    if not isinstance(patch, dict) or set(patch) - CONFIGURABLE:
        raise ValueError('수집 설정 필드 오류')
    # me() and the team topic are network calls, so they run before taking the lock.
    profile = pipeline.client.me() if 'teamId' in patch else None
    if 'projectTopic' in patch:
        _share_topic(pipeline, patch)
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
