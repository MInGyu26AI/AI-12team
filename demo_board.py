"""Loopback demo team board (`app.py board`): shows and stores version 1 approvals from the review page."""
import hmac
import json
import sqlite3

from card_contract import PACKET_FIELDS, validate_packet
from html_page import card_html, page
from secure_http import SecureHandler
from storage import connect


class Board(SecureHandler):
    def do_GET(self):
        if not self.valid_host() or self.path != "/":
            return self.reply(404, "페이지를 찾을 수 없습니다.")
        with connect(self.server.db) as c:
            rows = c.execute("SELECT * FROM records ORDER BY rowid DESC").fetchall()
        body = '<header><h1>팀 보드</h1><span class="state">로컬 시연 팀</span></header>'
        body += f'<p>승인된 카드 {len(rows)}장</p>' + "".join(card_html(r) for r in rows)
        self.reply(200, page("팀 보드", body, True))

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.secret)

    def do_POST(self):
        if not self.valid_host() or self.path != "/items/approve" or not self.authorized():
            return self.reply(403, "거절됨")
        try:
            packet = json.loads(self.body())
            validate_packet(packet)
            if "version" in packet:
                # Team (version 2) cards only go to a team server; this board stores the five version 1 fields.
                raise ValueError("로컬 보드는 v1 승인만 받습니다.")
            with connect(self.server.db) as c:
                c.execute("INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING", tuple(packet[k] for k in PACKET_FIELDS))
                saved = dict(c.execute("SELECT * FROM records WHERE id=?", (packet["id"],)).fetchone())
            if saved != packet:
                return self.reply(409, "이전 승인과 내용이 다릅니다.")
            self.reply(200, json.dumps({"id": packet["id"]}), "application/json")
        except (ValueError, TypeError, KeyError):
            self.reply(400, "승인 형식 오류")
        except (sqlite3.Error, OSError):
            self.reply(503, "팀 보드 저장을 확인하지 못했습니다.")
