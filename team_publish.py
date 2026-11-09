"""Accepting one approved card into the team's append-only record."""
import math
import time

from psycopg.types.json import Jsonb

from conflict_checks import enqueue
from delivery import validate_packet
from team_access import AccessError

ENVELOPE = {'packet', 'approved_by', 'approved_at'}
MAX_CLOCK_SKEW_SECONDS = 300  # an approval time may run this far ahead of the server clock


def publish(c, team_id, user_id, data):
    """Store the approver's own card exactly once; a retry must repeat the stored envelope.

    The caller holds the team lock."""
    if not isinstance(data, dict) or set(data) != ENVELOPE:
        raise ValueError('Invalid envelope')
    validate_packet(data['packet'])
    if data['approved_by'] != user_id:
        raise AccessError(403)
    if not _valid_approval_time(data['approved_at']):
        raise ValueError('Invalid approval time')
    packet = data['packet']
    c.execute('''INSERT INTO syncup.shared_cards(team_id,id,approved_by,approved_at,packet)
        VALUES(%s,%s,%s,%s,%s) ON CONFLICT(team_id,id) DO NOTHING''',
        (team_id, packet['id'], user_id, data['approved_at'], Jsonb(packet)))
    saved = c.execute('''SELECT packet,approved_by::text,approved_at FROM syncup.shared_cards
        WHERE team_id=%s AND id=%s''', (team_id, packet['id'])).fetchone()
    if saved != data:
        raise AccessError(409)
    enqueue(c, team_id, packet)
    return dict(id=packet['id'], team_id=str(team_id), approved_by=user_id)


def _valid_approval_time(stamp):
    return type(stamp) in (int, float) and math.isfinite(stamp) and 0 < stamp <= time.time() + MAX_CLOCK_SKEW_SECONDS
