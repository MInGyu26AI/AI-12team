"""결정·커밋 어긋남 판정 (외부 AI 없이, 가짜 모델)."""
import unittest

from syncup_ai import commit_check
from syncup_ai.team_state import build_state
from tests.fakes import FakeLLM

T0 = 1793966400  # 2026-11-06 21:00 KST


def decision(cid, topic, content, owner, at=0):
    return {"id": cid, "relevance": "related", "tag": "decision", "subtopic": "작업·결과물", "topic_key": topic,
            "content": content, "owner": owner, "approvedAt": T0 + at, "decisionState": "active"}


STATE = build_state([decision("c1", "MVP 범위", "브라우저 확장 = 행사 이후", "박지민"),
                     decision("c2", "DB", "DB = SQLite", "이서준", at=60)])
ID = {d["topic_key"]: d["id"] for d in commit_check.current_decisions(STATE)}  # 팀 상태 파일 순서로 d1, d2 …
COMMIT = {"sha": "a1b2c3d", "message": "extension 폴더 추가, 팝업 구현", "author": "kimdonggyun",
          "files": ["extension/popup.tsx", "extension/manifest.json"]}


class CommitCheckTest(unittest.TestCase):
    def test_only_conflicts_become_alerts(self):
        llm = FakeLLM({"results": [
            {"id": ID["MVP 범위"], "judgement": "충돌", "reason": "행사 이후로 미룬 확장을 지금 추가함", "confidence": 0.9},
            {"id": ID["DB"], "judgement": "무관", "reason": "DB 와 관계없음", "confidence": 0.95},
        ]})
        [alert] = commit_check.check_commit(COMMIT, STATE, llm)
        self.assertEqual((alert["commit"], alert["topic_key"], alert["judgement"]), ("a1b2c3d", "MVP 범위", "충돌"))
        self.assertEqual(alert["decision"], "브라우저 확장 = 행사 이후")
        self.assertIn("extension/popup.tsx", llm.prompts[0])
        self.assertIn("브라우저 확장 = 행사 이후", llm.prompts[0])

    def test_low_confidence_conflict_needs_check(self):
        llm = FakeLLM({"results": [{"id": ID["DB"], "judgement": "충돌", "reason": "x", "confidence": 0.4}]})
        [alert] = commit_check.check_commit(COMMIT, STATE, llm)
        self.assertEqual(alert["judgement"], "확인 필요")

    def test_no_decisions_means_no_model_call(self):
        llm = FakeLLM({"results": []})
        self.assertEqual(commit_check.check_commit(COMMIT, build_state([]), llm), [])
        self.assertEqual(llm.prompts, [])

    def test_commit_text_is_masked_before_sending(self):
        llm = FakeLLM({"results": []})
        leaky = {**COMMIT, "message": "배포 키 sk-proj-AbCdEf0123456789_xyz-QRSTuvwx 추가"}
        commit_check.check_commit(leaky, STATE, llm)
        self.assertNotIn("AbCdEf0123456789", llm.prompts[0])

    def test_request_errors(self):
        self.assertFalse(commit_check.handle_request({"commit": COMMIT, "state": STATE}, None)["ok"])
        self.assertFalse(commit_check.handle_request({"commit": {}, "state": STATE}, FakeLLM({}))["ok"])
        ok = commit_check.handle_request({"commit": COMMIT, "state": STATE}, FakeLLM({"results": []}))
        self.assertEqual(ok, {"ok": True, "alerts": []})


if __name__ == "__main__":
    unittest.main()
