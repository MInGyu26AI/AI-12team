"""Team settings every member reads and edits: the project topic all collectors classify by, and the board's
goal, scope and rules. One row per team in syncup.team_settings; the latest member to change it is recorded."""
import json

from team_access import AccessError, team_lock

LIMITS = {'topic': 1200, 'goal': 500, 'scope': 500}  # topic: collector/collection_settings.py MAX_TOPIC
MAX_RULES, MAX_RULE = 20, 200
FIELDS = ('topic', 'goal', 'scope', 'rules')


def read_settings(c, team_id):
    """The team's settings; empty values and updatedAt None when no member has saved any yet."""
    row = c.execute('SELECT topic,goal,scope,rules,actor,at FROM syncup.team_settings WHERE team_id=%s',
                    (team_id,)).fetchone()
    if not row:
        return dict(topic='', goal='', scope='', rules=[], updatedBy=None, updatedAt=None)
    return dict(topic=row['topic'], goal=row['goal'], scope=row['scope'], rules=list(row['rules']),
                updatedBy=str(row['actor']), updatedAt=row['at'].isoformat())


def _check(data):
    if not isinstance(data, dict) or not data or set(data) - set(FIELDS):
        raise ValueError('팀 설정 필드 오류')
    for field, limit in LIMITS.items():
        if field in data and (not isinstance(data[field], str) or len(data[field]) > limit):
            raise ValueError('팀 설정 길이 오류')
    rules = data.get('rules', [])
    if not isinstance(rules, list) or len(rules) > MAX_RULES or any(
            not isinstance(r, str) or not r.strip() or len(r) > MAX_RULE for r in rules):
        raise ValueError('팀 규칙 형식 오류')


def update_settings(c, team_id, user_id, data):
    """Change the given fields and keep the others; the caller holds the team write lock."""
    _check(data)
    current = read_settings(c, team_id)
    merged = {field: data.get(field, current[field]) for field in FIELDS}
    c.execute('''INSERT INTO syncup.team_settings(team_id,topic,goal,scope,rules,actor) VALUES(%s,%s,%s,%s,%s::jsonb,%s)
        ON CONFLICT(team_id) DO UPDATE SET topic=excluded.topic,goal=excluded.goal,scope=excluded.scope,
            rules=excluded.rules,actor=excluded.actor,at=clock_timestamp()''',
        (team_id, merged['topic'].strip(), merged['goal'].strip(), merged['scope'].strip(),
         json.dumps([r.strip() for r in merged['rules']], ensure_ascii=False), user_id))
    return read_settings(c, team_id)


def settings_request(c, team_id, user_id, method, data):
    """GET or POST /teams/{id}/settings."""
    if method == 'GET':
        return dict(team_id=str(team_id), settings=read_settings(c, team_id))
    if method != 'POST':
        raise AccessError(405)
    team_lock(c, team_id)
    return dict(team_id=str(team_id), settings=update_settings(c, team_id, user_id, data))


def state_team(c, team_id):
    """The goal, scope and rules syncup.json carries in its team block (empty values are dropped there)."""
    s = read_settings(c, team_id)
    return dict(goal=s['goal'], scope=s['scope'], rules=s['rules'])
