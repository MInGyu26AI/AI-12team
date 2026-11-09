"""The collection session in the private database: whether collection runs now, pause and resume, the team binding."""
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


def bind_sharing(c, client, team_id=None, profile=None):
    """Bind this state folder to the client's server and user (once, then immutable) and optionally to one of its teams.

    profile is client.me(); pass it in when the caller already has it, so no network call runs in the transaction.
    """
    profile = client.me() if profile is None else profile
    if profile['user_id'] != client.user_id:
        raise ValueError('연결 사용자가 변경되었습니다.')
    existing = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
    if existing and (existing['api_url'] != client.api_url or existing['user_id'] != client.user_id):
        raise ValueError('사용자나 팀 서버를 바꾸려면 별도 상태 폴더를 사용하세요.')
    if team_id is not None and team_id not in {t['id'] for t in profile['teams']}:
        raise ValueError('선택한 팀의 구성원이 아닙니다.')
    if not existing:
        c.execute('INSERT INTO sharing VALUES(1,?,?,?)', (client.api_url, client.user_id, team_id))
    elif team_id is not None:
        c.execute('UPDATE sharing SET team_id=? WHERE id=1', (team_id,))
    return profile


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
