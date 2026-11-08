"""Persist approval before HTTP; retry only the frozen request."""
import http.client
import json
import time
import urllib.error
import urllib.request

from collector import LABELS
from storage import connect

MAX_ATTEMPTS = 5
PACKET_FIELDS = ("id", "label", "text", "quote", "speaker")


def validate_packet(packet):
    if not isinstance(packet, dict):
        raise ValueError("승인 형식 오류")
    if packet.get('version') == 2:
        from card_contract import validate_v2
        validate_v2(packet)
    elif set(packet) != set(PACKET_FIELDS):
        raise ValueError("승인 형식 오류")
    if any(not isinstance(packet[k], str) or not packet[k].strip() or len(packet[k]) > 1200 for k in PACKET_FIELDS):
        raise ValueError("승인 값 오류")
    if packet["label"] not in (*LABELS.values(), "결정 · 채택 미확인") or packet["speaker"] not in ("사용자", "AI"):
        raise ValueError("승인 유형 오류")


def approve(c, get, destination=None):
    r = c.execute("SELECT cards.*,jobs.evidence FROM cards JOIN jobs ON cards.job=jobs.id WHERE cards.id=?", (get("id"),)).fetchone()
    if not r:
        raise ValueError("카드를 찾을 수 없습니다.")
    if r["status"] in ("queued", "shared"):
        return
    if r["status"] not in ("ready", "manual"):
        raise ValueError("승인 가능한 상태가 아닙니다.")
    text = get("text").strip()
    if r["status"] == "manual":
        source = next((x for x in json.loads(r["evidence"]) if str(x["n"]) == get("source")), None)
        if not source:
            raise ValueError("근거를 선택해 주세요.")
        quote, role = source["text"], source["role"]
    else:
        quote, role = get("quote").strip(), r["role"]
        if not quote or quote not in r["quote"]:
            raise ValueError("원문에 포함된 근거를 선택해 주세요.")
    label = LABELS[r["kind"]] + (" · 채택 미확인" if r["kind"] == "decision" and not r["adopted"] else "")
    packet = dict(id=r["id"], label=label, text=text, quote=quote, speaker="사용자" if role == "user" else "AI")
    details = None
    if c.execute("SELECT 1 FROM sqlite_master WHERE name='candidate_details'").fetchone():
        details = c.execute('SELECT * FROM candidate_details WHERE id=?', (r['id'],)).fetchone()
    if details:
        from card_contract import PUBLIC_FIELDS
        card = json.loads(details['body'])
        if details['dismissed'] or not destination or details['team_id'] != destination['team_id']:
            raise ValueError('수집 당시 팀과 승인 대상 팀을 확인하세요.')
        if card.get('evidence', {}).get('roleGuessed'):
            raise ValueError('근거 발화의 화자를 먼저 확인하세요.')
        public = {k: card[k] for k in PUBLIC_FIELDS}
        public.update(content=text, sentence=quote)
        packet.update(version=2, card=public)
    validate_packet(packet)
    if destination is not None:
        binding = c.execute('SELECT * FROM sharing WHERE id=1').fetchone()
        if not binding or any(destination[k] != binding[k] for k in ('api_url', 'user_id', 'team_id')) or not binding['team_id']:
            raise ValueError('팀 선택이 변경되었습니다. 새로고침 후 승인하세요.')
    elif c.execute('SELECT 1 FROM sharing').fetchone():
        raise ValueError('대상 팀을 확인한 후 승인하세요.')
    c.execute("INSERT INTO outbox(id,payload,state,created) VALUES(?,?,'pending',?)",
              (r["id"], json.dumps(packet, ensure_ascii=False), time.time()))
    if destination is not None:
        c.execute('INSERT INTO outbox_destinations VALUES(?,?,?,?)',
                  (r['id'], destination['api_url'], destination['user_id'], destination['team_id']))
    c.execute("UPDATE cards SET status='queued',draft=?,quote=?,role=? WHERE id=?", (text, quote, role, r["id"]))
    c.execute("""UPDATE jobs SET state='done',detail='' WHERE id=? AND state='failed_draft'
        AND NOT EXISTS (SELECT 1 FROM cards WHERE job=? AND status IN ('drafting','manual'))""", (r["job"], r["job"]))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def deliver(db, board_url, secret, team_client=None):
    with connect(db) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY created LIMIT 1", (time.time(),)).fetchone()
        if not row:
            return False
        destination = c.execute('SELECT * FROM outbox_destinations WHERE id=?', (row['id'],)).fetchone()
        bound = c.execute('SELECT 1 FROM sharing').fetchone()
        if ((destination is None and (team_client is not None or bound))
                or (destination is not None and (team_client is None or
                    destination['api_url'] != team_client.api_url or destination['user_id'] != team_client.user_id))):
            c.execute("UPDATE outbox SET state='blocked',detail='승인 당시 연결과 다릅니다. 자동 전송하지 않았습니다.' WHERE id=?", (row['id'],))
            return True
        if row["attempts"] >= MAX_ATTEMPTS:
            c.execute("UPDATE outbox SET state='blocked',detail='자동 재시도 횟수 초과' WHERE id=?", (row["id"],))
            return True
        attempt = row["attempts"] + 1
        delay = 2 ** attempt
        # Persist the attempt before I/O so a crash cannot reset the retry budget.
        c.execute("UPDATE outbox SET attempts=?,next_attempt=? WHERE id=?", (attempt, time.time() + delay, row["id"]))
    detail, transient = "", False
    try:
        if destination is not None:
            team_client.publish(destination, row['payload'], row['created'])
        else:
            request = urllib.request.Request(board_url + "items/approve", row["payload"].encode(),
                {"Authorization": "Bearer " + secret, "Content-Type": "application/json"})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=8) as response:
                ack = json.loads(response.read(16385))
                if response.status != 200 or not isinstance(ack, dict) or ack.get("id") != row["id"]:
                    raise ValueError("승인 응답 불일치")
    except urllib.error.HTTPError as error:
        from diagnostics import failure
        failure('publish', error, row['id'])
        detail = f"팀 보드 HTTP {error.code}"
        transient = error.code in (408, 425, 429) or 500 <= error.code < 600
        error.close()
    except (OSError, http.client.HTTPException, ValueError) as error:
        from diagnostics import failure
        failure('publish', error, row['id'])
        detail = "팀 보드 응답 확인 실패 · " + type(error).__name__
        transient = True
    with connect(db) as c:
        if detail:
            state = "pending" if transient and attempt < MAX_ATTEMPTS else "blocked"
            c.execute("UPDATE outbox SET state=?,next_attempt=?,detail=? WHERE id=?",
                      (state, time.time() + delay, detail, row["id"]))
        else:
            c.execute("UPDATE outbox SET state='sent',detail='' WHERE id=?", (row["id"],))
            c.execute("UPDATE cards SET status='shared' WHERE id=?", (row["id"],))
    return True
