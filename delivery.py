"""Persist approval before HTTP; retry only the frozen request, and only to the team server it was approved for."""
import http.client
import json
import time
import urllib.error

from card_contract import PUBLIC_FIELDS, card_label, validate_packet
from diagnostics import failure
from storage import connect

MAX_ATTEMPTS = 5
# Outbox rows whose recorded destination is the current sharing binding (same team, user and server).
CURRENT_DESTINATION = """id IN (SELECT d.id FROM outbox_destinations d JOIN sharing s
    ON s.team_id=d.team_id AND s.user_id=d.user_id AND s.api_url=d.api_url)"""


def _approved_evidence(r, get):
    """(quote, role) the user approved: a chosen excerpt for manual cards, otherwise part of the drafted quote."""
    if r["status"] == "manual":
        source = next((x for x in json.loads(r["evidence"]) if str(x["n"]) == get("source")), None)
        if not source:
            raise ValueError("근거를 선택해 주세요.")
        return source["text"], source["role"]
    quote = get("quote").strip()
    if not quote or quote not in r["quote"]:
        raise ValueError("원문에 포함된 근거를 선택해 주세요.")
    return quote, r["role"]


def _candidate_card(c, r, text, quote, destination):
    """The public v2 card of a pipeline candidate, or None for a card the legacy collector drafted."""
    if not c.execute("SELECT 1 FROM sqlite_master WHERE name='candidate_details'").fetchone():
        return None
    details = c.execute('SELECT * FROM candidate_details WHERE id=?', (r['id'],)).fetchone()
    if not details:
        return None
    card = json.loads(details['body'])
    if details['dismissed'] or not destination or details['team_id'] != destination['team_id']:
        raise ValueError('수집 당시 팀과 승인 대상 팀을 확인하세요.')
    if card.get('evidence', {}).get('roleGuessed'):
        raise ValueError('근거 발화의 화자를 먼저 확인하세요.')
    public = {k: card[k] for k in PUBLIC_FIELDS}
    public.update(content=text, sentence=quote)
    return public


def _check_destination(c, destination):
    if destination is not None:
        binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
        if not binding or any(destination[k] != binding[k] for k in ('api_url', 'user_id', 'team_id')) or not binding['team_id']:
            raise ValueError('팀 선택이 변경되었습니다. 새로고침 후 승인하세요.')
    elif c.execute('SELECT 1 FROM sharing').fetchone():
        raise ValueError('대상 팀을 확인한 후 승인하세요.')


def approve(c, get, destination=None):
    r = c.execute("SELECT cards.*,jobs.evidence FROM cards JOIN jobs ON cards.job=jobs.id WHERE cards.id=?", (get("id"),)).fetchone()
    if not r:
        raise ValueError("카드를 찾을 수 없습니다.")
    if r["status"] in ("queued", "shared"):
        return
    if r["status"] not in ("ready", "manual"):
        raise ValueError("승인 가능한 상태가 아닙니다.")
    text = get("text").strip()
    quote, role = _approved_evidence(r, get)
    packet = dict(id=r["id"], label=card_label(r["kind"], r["adopted"]), text=text, quote=quote,
                  speaker="사용자" if role == "user" else "AI")
    card = _candidate_card(c, r, text, quote, destination)
    if card:
        packet.update(version=2, card=card)
    validate_packet(packet)
    _check_destination(c, destination)
    c.execute("INSERT INTO outbox(id,payload,state,created) VALUES(?,?,'pending',?)",
              (r["id"], json.dumps(packet, ensure_ascii=False), time.time()))
    if destination is not None:
        c.execute('INSERT INTO outbox_destinations VALUES(?,?,?,?)',
                  (r['id'], destination['api_url'], destination['user_id'], destination['team_id']))
    c.execute("UPDATE cards SET status='queued',draft=?,quote=?,role=? WHERE id=?", (text, quote, role, r["id"]))
    c.execute("""UPDATE jobs SET state='done',detail='' WHERE id=? AND state='failed_draft'
        AND NOT EXISTS (SELECT 1 FROM cards WHERE job=? AND status IN ('drafting','manual'))""", (r["job"], r["job"]))


def reset_blocked(c, identifier):
    """Requeue one blocked approval for the current sharing binding unchanged, with a fresh retry budget.

    Returns whether a row was requeued.
    """
    updated = c.execute("UPDATE outbox SET state='pending',attempts=0,next_attempt=0,detail='' WHERE id=? AND state='blocked' AND "
                        + CURRENT_DESTINATION, (identifier,))
    return updated.rowcount == 1


def _blocked_detail(row, destination, team_client):
    """Why this approval must not be sent automatically, or None.

    An approval without a recorded destination was made before its state folder had a team server (the former local
    demo mode); it is never sent.
    """
    if (destination is None or team_client is None or destination['api_url'] != team_client.api_url
            or destination['user_id'] != team_client.user_id):
        return '승인 당시 연결과 다릅니다. 자동 전송하지 않았습니다.'
    if row["attempts"] >= MAX_ATTEMPTS:
        return '자동 재시도 횟수 초과'
    return None


def _send(team_client, row, destination):
    """('', False) when delivered, otherwise (detail, whether the failure is worth retrying)."""
    try:
        team_client.publish(destination, row['payload'], row['created'])
    except urllib.error.HTTPError as error:
        failure('publish', error, row['id'])
        error.close()
        return f"팀 보드 HTTP {error.code}", error.code in (408, 425, 429) or 500 <= error.code < 600
    except (OSError, http.client.HTTPException, ValueError) as error:
        failure('publish', error, row['id'])
        return "팀 보드 응답 확인 실패 · " + type(error).__name__, True
    return "", False


def deliver(db, team_client):
    """Send the next due approval once with team_client (None: block it). Returns False when nothing was due."""
    with connect(db) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY created LIMIT 1",
                        (time.time(),)).fetchone()
        if not row:
            return False
        destination = c.execute('SELECT * FROM outbox_destinations WHERE id=?', (row['id'],)).fetchone()
        blocked = _blocked_detail(row, destination, team_client)
        if blocked:
            c.execute("UPDATE outbox SET state='blocked',detail=? WHERE id=?", (blocked, row['id']))
            return True
        attempt = row["attempts"] + 1
        delay = 2 ** attempt
        # Persist the attempt before I/O so a crash cannot reset the retry budget.
        c.execute("UPDATE outbox SET attempts=?,next_attempt=? WHERE id=?", (attempt, time.time() + delay, row["id"]))
    detail, transient = _send(team_client, row, destination)
    with connect(db) as c:
        if detail:
            state = "pending" if transient and attempt < MAX_ATTEMPTS else "blocked"
            c.execute("UPDATE outbox SET state=?,next_attempt=?,detail=? WHERE id=?",
                      (state, time.time() + delay, detail, row["id"]))
        else:
            c.execute("UPDATE outbox SET state='sent',detail='' WHERE id=?", (row["id"],))
            c.execute("UPDATE cards SET status='shared' WHERE id=?", (row["id"],))
    return True
