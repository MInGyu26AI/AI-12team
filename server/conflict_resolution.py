"""Resolving conflict alerts: the team's choice, its append-only history and the decision states it changes."""
from team_access import AccessError

CHOICES = ('keep-existing', 'adopt-new', 'both-valid', 'discuss')
NOTE_MAX_CHARS = 1200
# A final choice closes the losing card: the new card B is rejected, or the existing card A is superseded.
CLOSES = {'keep-existing': ('card_b', 'rejected'), 'adopt-new': ('card_a', 'superseded')}
OBSOLETE_NOTE = '관련 결정이 다른 해결에서 종료됨'


def resolve(c, team_id, user_id, conflict_id, data):
    """Apply one member's choice; the caller holds the team lock."""
    choice, note = _parse_choice(data)
    row = c.execute('SELECT * FROM syncup.conflicts WHERE team_id=%s AND id=%s FOR UPDATE',
                    (team_id, conflict_id)).fetchone()
    if not row:
        raise AccessError(404)
    # Resending the same choice and note succeeds; only an open or 'discuss' conflict can still change.
    if (row['resolution'], row['note']) == (choice, note):
        return
    if row['resolution'] not in (None, 'discuss'):
        raise AccessError(409)
    c.execute('UPDATE syncup.conflicts SET resolution=%s,note=%s WHERE team_id=%s AND id=%s',
              (choice, note, team_id, row['id']))
    _log_event(c, team_id, row['id'], user_id, choice, note)
    if choice in CLOSES:
        column, state = CLOSES[choice]
        _close(c, team_id, user_id, row[column], state)
    _refresh_review_states(c, team_id)


def _parse_choice(data):
    if set(data) - {'resolution', 'resolutionNote'}:
        raise ValueError('해결 필드 오류')
    choice, note = data.get('resolution'), data.get('resolutionNote', '')
    if choice not in CHOICES or not isinstance(note, str) or len(note) > NOTE_MAX_CHARS:
        raise ValueError('해결 선택 오류')
    return choice, note


def _close(c, team_id, user_id, card_id, state):
    """Retire a losing card and mark the other open alerts about it obsolete."""
    c.execute('UPDATE syncup.record_states SET state=%s WHERE team_id=%s AND card_id=%s', (state, team_id, card_id))
    stale = c.execute('''UPDATE syncup.conflicts SET resolution='obsolete',note=%s
        WHERE team_id=%s AND (card_a=%s OR card_b=%s) AND (resolution IS NULL OR resolution='discuss')
        RETURNING id''', (OBSOLETE_NOTE, team_id, card_id, card_id)).fetchall()
    for r in stale:
        _log_event(c, team_id, r['id'], user_id, 'obsolete', OBSOLETE_NOTE)


def _refresh_review_states(c, team_id):
    """A live decision stays in review while it is the new card of any open or discussed alert."""
    c.execute('''UPDATE syncup.record_states s SET state=CASE WHEN EXISTS(
            SELECT 1 FROM syncup.conflicts x WHERE x.team_id=s.team_id AND x.card_b=s.card_id
            AND (x.resolution IS NULL OR x.resolution='discuss')) THEN 'review' ELSE 'active' END
        WHERE s.team_id=%s AND s.state IN ('active','review')''', (team_id,))


def _log_event(c, team_id, conflict_id, user_id, resolution, note):
    c.execute('''INSERT INTO syncup.conflict_events(team_id,conflict_id,actor,resolution,note)
        VALUES(%s,%s,%s,%s,%s)''', (team_id, conflict_id, user_id, resolution, note))
