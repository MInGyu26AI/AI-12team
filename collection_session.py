"""The collection session in the private database: whether collection runs now, pause and resume, the bound team."""
import time

from storage import connect


def active(s):
    return s and not s["paused"] and s["start"] <= time.time() < s["end"]


def session_state(s):
    """'ended', 'paused' or 'collecting'."""
    if time.time() >= s["end"]:
        return "ended"
    return "paused" if s["paused"] else "collecting"


def config(db):
    with connect(db) as c:
        return c.execute("SELECT * FROM settings").fetchone()


def set_paused(c, paused):
    """Pause or resume collection in the caller's transaction; resuming needs an end time still ahead."""
    now = time.time()
    if paused:
        c.execute("INSERT INTO pauses(start) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM pauses WHERE end IS NULL)", (now,))
    else:
        if c.execute("SELECT end FROM settings").fetchone()[0] <= now:
            raise ValueError("수집 종료 시각을 먼저 갱신하세요.")
        c.execute("UPDATE pauses SET end=? WHERE end IS NULL", (now,))
    c.execute("UPDATE settings SET paused=?", (int(paused),))


def bound_team(c):
    """The team new approvals go to (None until one is chosen)."""
    return c.execute('SELECT team_id FROM sharing').fetchone()[0]


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
