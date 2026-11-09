"""Persist approval before HTTP; retry only the frozen request."""
import http.client
import json
import time
import urllib.error
import urllib.request

from card_contract import KIND_LABELS, MAX_TEXT, PUBLIC_FIELDS, UNADOPTED_LABEL, card_label, validate_v2
from diagnostics import failure
from storage import connect

MAX_ATTEMPTS = 5
PACKET_FIELDS = ("id", "label", "text", "quote", "speaker")
# The loopback demo board answers with {"id": ...}; anything longer is refused.
ACK_LIMIT = 16 * 1024
# Outbox rows whose recorded destination is the current sharing binding (same team, user and server).
CURRENT_DESTINATION = """id IN (SELECT d.id FROM outbox_destinations d JOIN sharing s
    ON s.team_id=d.team_id AND s.user_id=d.user_id AND s.api_url=d.api_url)"""
# Outbox rows approved for the loopback demo board, which records no destination.
DEMO_BOARD_DESTINATION = "id NOT IN (SELECT id FROM outbox_destinations)"


def validate_packet(packet):
    if not isinstance(packet, dict):
        raise ValueError("승인 형식 오류")
    if packet.get('version') == 2:
        validate_v2(packet)
    elif set(packet) != set(PACKET_FIELDS):
        raise ValueError("승인 형식 오류")
    if any(not isinstance(packet[k], str) or not packet[k].strip() or len(packet[k]) > MAX_TEXT for k in PACKET_FIELDS):
        raise ValueError("승인 값 오류")
    if packet["label"] not in (*KIND_LABELS.values(), UNADOPTED_LABEL) or packet["speaker"] not in ("사용자", "AI"):
        raise ValueError("승인 유형 오류")


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


def reset_blocked(c, identifier, scope):
    """Requeue one blocked approval unchanged with a fresh retry budget; scope is one of the destination conditions above.

    Returns whether a row was requeued.
    """
    updated = c.execute("UPDATE outbox SET state='pending',attempts=0,next_attempt=0,detail='' WHERE id=? AND state='blocked' AND "
                        + scope, (identifier,))
    return updated.rowcount == 1


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _blocked_detail(c, row, destination, team_client):
    """Why this approval must not be sent automatically, or None."""
    if destination is None:
        changed = team_client is not None or c.execute('SELECT 1 FROM sharing').fetchone()
    else:
        changed = (team_client is None or destination['api_url'] != team_client.api_url
                   or destination['user_id'] != team_client.user_id)
    if changed:
        return '승인 당시 연결과 다릅니다. 자동 전송하지 않았습니다.'
    if row["attempts"] >= MAX_ATTEMPTS:
        return '자동 재시도 횟수 초과'
    return None


def _post_to_demo_board(board_url, secret, row):
    request = urllib.request.Request(board_url + "items/approve", row["payload"].encode(),
        {"Authorization": "Bearer " + secret, "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=8) as response:
        raw = response.read(ACK_LIMIT + 1)
        if len(raw) > ACK_LIMIT:
            raise ValueError("승인 응답이 너무 큽니다")
        ack = json.loads(raw)
        if response.status != 200 or not isinstance(ack, dict) or ack.get("id") != row["id"]:
            raise ValueError("승인 응답 불일치")


def _send(board_url, secret, team_client, row, destination):
    """('', False) when delivered, otherwise (detail, whether the failure is worth retrying)."""
    try:
        if destination is not None:
            team_client.publish(destination, row['payload'], row['created'])
        else:
            _post_to_demo_board(board_url, secret, row)
    except urllib.error.HTTPError as error:
        failure('publish', error, row['id'])
        error.close()
        return f"팀 보드 HTTP {error.code}", error.code in (408, 425, 429) or 500 <= error.code < 600
    except (OSError, http.client.HTTPException, ValueError) as error:
        failure('publish', error, row['id'])
        return "팀 보드 응답 확인 실패 · " + type(error).__name__, True
    return "", False


def deliver(db, board_url, secret, team_client=None):
    """Send the next due approval once. Returns False when nothing was due."""
    with connect(db) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY created LIMIT 1", (time.time(),)).fetchone()
        if not row:
            return False
        destination = c.execute('SELECT * FROM outbox_destinations WHERE id=?', (row['id'],)).fetchone()
        blocked = _blocked_detail(c, row, destination, team_client)
        if blocked:
            c.execute("UPDATE outbox SET state='blocked',detail=? WHERE id=?", (blocked, row['id']))
            return True
        attempt = row["attempts"] + 1
        delay = 2 ** attempt
        # Persist the attempt before I/O so a crash cannot reset the retry budget.
        c.execute("UPDATE outbox SET attempts=?,next_attempt=? WHERE id=?", (attempt, time.time() + delay, row["id"]))
    detail, transient = _send(board_url, secret, team_client, row, destination)
    with connect(db) as c:
        if detail:
            state = "pending" if transient and attempt < MAX_ATTEMPTS else "blocked"
            c.execute("UPDATE outbox SET state=?,next_attempt=?,detail=? WHERE id=?",
                      (state, time.time() + delay, detail, row["id"]))
        else:
            c.execute("UPDATE outbox SET state='sent',detail='' WHERE id=?", (row["id"],))
            c.execute("UPDATE cards SET status='shared' WHERE id=?", (row["id"],))
    return True
