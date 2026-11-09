"""The team board: shared cards, decisions, open conflicts and resolution history, plus to-do checkmarks."""
from card_contract import LABELS, board_card
from team_access import AccessError

ITEMS_LIMIT = 200  # newest shared cards per GET /items


def shared_items(c, team_id):
    return c.execute('''SELECT packet,approved_by::text,approved_at FROM syncup.shared_cards
        WHERE team_id=%s ORDER BY received_at DESC,id LIMIT %s''', (team_id, ITEMS_LIMIT)).fetchall()


def shared_item(c, team_id, card_id):
    """One card as a one-row list: GET /items/{id} answers in the same `items` shape as the list."""
    rows = c.execute('SELECT packet,approved_by::text,approved_at FROM syncup.shared_cards WHERE team_id=%s AND id=%s',
                     (team_id, card_id)).fetchall()
    if not rows:
        raise AccessError(404)
    return rows


def board(c, team_id, history=False):
    """Board cards in approval order; without `history` only active and in-review decisions remain."""
    rows = c.execute('''SELECT r.packet,r.approved_by::text,r.approved_at,
            coalesce(s.state,'active') AS decision_state,coalesce(k.state,'not-required') AS check_state,
            coalesce(k.detail,'') AS check_detail,k.progress
        FROM syncup.shared_cards r
        LEFT JOIN syncup.record_states s ON (s.team_id,s.card_id)=(r.team_id,r.id)
        LEFT JOIN syncup.conflict_checks k ON (k.team_id,k.card_id)=(r.team_id,r.id)
        WHERE r.team_id=%s AND (%s OR coalesce(s.state,'active') IN ('active','review'))
        ORDER BY r.received_at,r.id''', (team_id, history)).fetchall()
    return [dict(board_card(r), decisionState=r['decision_state'], conflictCheckStatus=r['check_state'],
                 conflictCheckDetail=r['check_detail'], conflictCheckProgress=_progress_view(r['progress']))
            for r in rows]


def _progress_view(progress):
    """Checkpoint counts for the board; `completed` counts only the pairs that were actually compared."""
    if not progress or 'ids' not in progress:
        return None
    return dict(total=len(progress['ids']), completed=progress['cursor'] - progress['skipped'],
                skipped=progress['skipped'])


def conflicts(c, team_id, history=False):
    """Conflict alerts; without `history` only unresolved ones and those sent back to the team for discussion."""
    rows = c.execute('''SELECT payload,resolution,note FROM syncup.conflicts
        WHERE team_id=%s AND (%s OR resolution IS NULL OR resolution='discuss') ORDER BY id''',
        (team_id, history)).fetchall()
    return [_conflict_view(r) for r in rows]


def _conflict_view(row):
    view = dict(row['payload'])
    if row['resolution']:
        view.update(resolution=row['resolution'], resolutionNote=row['note'])
    return view


def conflict_events(c, team_id):
    return c.execute('''SELECT conflict_id,actor::text,resolution,note,at::text
        FROM syncup.conflict_events WHERE team_id=%s ORDER BY id''', (team_id,)).fetchall()


def done_todos(c, team_id):
    rows = c.execute('SELECT card_id FROM syncup.todo_states WHERE team_id=%s AND done ORDER BY card_id', (team_id,))
    return [r['card_id'] for r in rows]


def mark_todo(c, team_id, user_id, card_id, data):
    """Check or uncheck one shared to-do; the latest member to change it is recorded."""
    if set(data) != {'done'} or type(data['done']) is not bool:
        raise ValueError('완료 상태 오류')
    row = c.execute('SELECT packet FROM syncup.shared_cards WHERE team_id=%s AND id=%s', (team_id, card_id)).fetchone()
    if not row or row['packet'].get('label') != LABELS['todo']:
        raise AccessError(404)
    c.execute('''INSERT INTO syncup.todo_states(team_id,card_id,done,actor) VALUES(%s,%s,%s,%s)
        ON CONFLICT(team_id,card_id) DO UPDATE SET done=excluded.done,actor=excluded.actor,at=clock_timestamp()''',
        (team_id, card_id, data['done'], user_id))
