"""팀 상태 파일(syncup.json·SYNCUP.md) 테스트.  python3 -m unittest tests.test_team_state -v"""
import json
import unittest

from syncup_ai.team_state import build_state, dumps, find_todo_ids, render_markdown, todo_ids

T0 = 1793966400  # 2026-11-06 21:00 KST
U1, U2 = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
MEMBERS = {U1: "박지민", U2: "이서준"}


def card(cid, tag, content, *, topic="MVP 범위", sub="작업·결과물", owner=None, due=None, at=0,
         state="active", by=U1, sentence="원문", reason=None):
    return {"id": cid, "status": "approved", "relevance": "related", "tag": tag, "subtopic": sub,
            "topic_key": topic, "content": content, "sentence": sentence, "source": "ChatGPT, 2026-11-06 21:10",
            "owner": owner, "due": due, "reason": reason, "is_change": False, "is_new_topic": False,
            "masked": False, "confidence": 0.9, "classificationMethod": "chat",
            "approvedBy": by, "approvedAt": T0 + at, "decisionState": state}


def board():
    return [
        card("c1", "decision", "브라우저 확장 = 행사 후", owner="박지민", at=0, state="superseded"),
        card("c2", "todo", "발표 슬라이드 초안", topic="발표 자료", sub="발표·제출", owner="최유나", due="2026-11-14", at=60),
        card("c3", "decision", "서비스명 = 싱크업", topic="서비스명", sub="주제·목표", owner="박지민", at=120),
        card("c4", "decision", "브라우저 확장 = MVP 포함", owner="이서준", at=600, by=U2,
             reason="대화 자동 수집이 있어야 시연 효과가 큼"),
        card("c5", "research", "Chrome MV3 는 백그라운드 페이지 대신 서비스 워커", topic="확장 구조", at=700),
        card("c6", "todo", "확장 zip 배포 페이지", topic="배포", owner="김단비", at=800),
        card("c7", "decision", "로고 이름 = MemBridge", topic="서비스명", sub="주제·목표", owner="최유나", at=900,
             state="review"),
        {"id": "p1", "relevance": "personal", "source": "x", "masked": False, "confidence": 0.9},
    ]


def conflicts():
    a, b, c3, c7 = (next(x for x in board() if x["id"] == i) for i in ("c1", "c4", "c3", "c7"))
    return [
        {"id": "k1", "topic_key": "MVP 범위", "cardA": a, "cardB": b, "judgement": "충돌",
         "reason": "다른 사람이 반대 결정", "resolution": "adopt-new", "resolutionNote": "시연 때문에 넣기로"},
        {"id": "k2", "topic_key": "서비스명", "cardA": c3, "cardB": c7, "judgement": "충돌",
         "reason": "기존 결정과 다른 이름"},
    ]


class TodoIdTest(unittest.TestCase):
    def test_ids_follow_board_order(self):
        self.assertEqual(todo_ids(board()), {"c2": "SU-1", "c6": "SU-2"})

    def test_find_in_commit_text(self):
        self.assertEqual(find_todo_ids("[SU-3] 배포 페이지, su-12 도 같이 (SU-3)"), ["SU-3", "SU-12"])
        self.assertEqual(find_todo_ids("SU-03 fix"), ["SU-3"])
        self.assertEqual(find_todo_ids("ISSU-3 / SU-3a / SU-"), [])


class StateTest(unittest.TestCase):
    def setUp(self):
        self.state = build_state(board(), conflicts(), done=["c6"],
                                 team={"name": "싱크업", "goal": "팀 AI 메모리", "rules": ["ChatGPT만 지원"],
                                       "secret": "x"}, members=MEMBERS)

    def test_current_and_history(self):
        topics = {t["topic_key"]: t for t in self.state["decisions"]}
        mvp = topics["MVP 범위"]
        self.assertEqual([d["card_id"] for d in mvp["current"]], ["c4"])
        self.assertEqual([d["card_id"] for d in mvp["history"]], ["c1"])
        self.assertEqual(mvp["status"], "settled")
        name = topics["서비스명"]
        self.assertEqual([d["card_id"] for d in name["current"]], ["c7", "c3"])  # 최신이 앞
        self.assertEqual(name["status"], "review")
        # 소주제 순서 (주제·목표 → 작업·결과물)
        self.assertEqual([t["topic_key"] for t in self.state["decisions"]], ["서비스명", "MVP 범위"])

    def test_todos_conflicts_summary(self):
        self.assertEqual([(t["id"], t["done"]) for t in self.state["todos"]], [("SU-1", False), ("SU-2", True)])
        self.assertEqual([c["id"] for c in self.state["open_conflicts"]], ["k2"])
        self.assertEqual(self.state["open_conflicts"][0]["status"], "open")
        self.assertEqual(self.state["resolved_conflicts"][0]["resolution"], "adopt-new")
        self.assertEqual(self.state["summary"], {"decisions": 3, "open_conflicts": 1, "todos": 2, "todos_done": 1,
                                                 "research": 1})
        self.assertEqual(self.state["updated_at"], "2026-11-06T21:15+09:00")
        self.assertEqual(set(self.state["team"]), {"name", "goal", "rules"})  # 모르는 필드는 버림

    def test_public_repo_safety(self):
        text = dumps(self.state)
        for leak in ("원문", "ChatGPT, 2026", U1, U2, "confidence"):
            self.assertNotIn(leak, text)
        masked = build_state([card("m1", "todo", "010-1234-5678 로 연락해서 서버 키 sk-proj-AbCdEf0123456789_xyz 받기")])
        self.assertNotIn("010-1234", dumps(masked))
        self.assertNotIn("sk-proj", dumps(masked))
        # owner 가 없으면 승인자 이름으로 (uuid 는 안 나감)
        st = build_state([card("d1", "decision", "x", owner=None, by=U2)], members=MEMBERS)
        self.assertEqual(st["decisions"][0]["current"][0]["owner"], "이서준")
        # 충돌 이유는 AI가 원문을 인용했어도 판정별 고정 문구로만 나간다
        quoted = [dict(conflicts()[1], reason="원문 '로고 이름은 MemBridge로 하자'와 어긋남")]
        st = build_state(board(), quoted)
        self.assertEqual(st["open_conflicts"][0]["reason"], "다른 사람이 합의 없이 양립할 수 없는 값을 정함")
        self.assertNotIn("로고 이름은", dumps(st) + render_markdown(st))

    def test_updated_at_counts_later_changes(self):
        # 충돌 처리·할 일 체크가 마지막 승인보다 늦으면 그 시각, 이르면 승인 시각
        later = build_state(board(), conflicts(), done=["c6"], changed_at=T0 + 3600)
        self.assertEqual(later["updated_at"], "2026-11-06T22:00+09:00")
        earlier = build_state(board(), conflicts(), done=["c6"], changed_at=T0)
        self.assertEqual(earlier["updated_at"], "2026-11-06T21:15+09:00")
        self.assertEqual(build_state([], changed_at=T0)["updated_at"], "2026-11-06T21:00+09:00")

    def test_stable_output(self):
        again = build_state(board(), conflicts(), done=["c6"],
                            team={"name": "싱크업", "goal": "팀 AI 메모리", "rules": ["ChatGPT만 지원"]}, members=MEMBERS)
        self.assertEqual(dumps(self.state), dumps(again))
        json.loads(dumps(self.state))

    def test_markdown(self):
        md = render_markdown(self.state)
        self.assertIn("# SyncUp 팀 기록 — 싱크업", md)
        self.assertIn("직접 고치지 마세요", md)
        self.assertIn("## ⚠️ 확인이 필요한 결정", md)
        self.assertIn("**MVP 범위**: 브라우저 확장 = MVP 포함 — 이서준, 11/6", md)
        self.assertIn("~~브라우저 확장 = 행사 후~~", md)
        self.assertIn("_(검토 중)_", md)
        self.assertIn("- [ ] `SU-1` 발표 슬라이드 초안 — 최유나 · 11/14까지", md)
        self.assertIn("- [x] `SU-2`", md)
        self.assertLess(md.index("SU-1"), md.index("SU-2"))  # 안 한 일이 먼저
        self.assertIn("새 결정 채택 — 시연 때문에 넣기로", md)

    def test_empty(self):
        st = build_state([])
        md = render_markdown(st)
        self.assertIn("아직 승인된 결정이 없습니다", md)
        self.assertIsNone(st["updated_at"])


if __name__ == "__main__":
    unittest.main()
