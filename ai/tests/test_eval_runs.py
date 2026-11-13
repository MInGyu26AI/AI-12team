"""평가 도구가 검사 실패(낮은 확신도·한도 초과·분류 오류)에서 멈추지 않고 미완료로 세는지."""
import unittest

from eval import run, sheet_eval
from eval.gold import CONFLICT_PAIRS, EXAMPLES
from tests.fakes import FakeDecider, dec

UNSURE = FakeDecider(lambda q: {"type": "choice", "name": q["name"], "choice": "충돌", "confidence": 0.3})


class Broken:
    def chat_json(self, system, user):
        raise ValueError("synthetic reply")


def gold_unit(unit, text, owner):
    return {"unit": unit, "message_id": unit.split("-")[0], "text": text, "relevance": "related", "subtopic": "기타",
            "tag": "decision", "topic_key": "DB", "owner": owner, "due": None, "is_change": False, "masked": False}


class EvalRunTest(unittest.TestCase):
    def test_conflict_eval_counts_low_confidence_pairs_as_incomplete(self):
        result = run.eval_conflict(None, UNSURE)
        self.assertEqual(result["incomplete"], len(CONFLICT_PAIRS))
        self.assertTrue(all(r["got"] == "미완료:low-confidence" for r in result["rows"]))

    def test_classify_eval_records_failed_requests(self):
        result = run.eval_classify(Broken())
        self.assertEqual(result["accuracy"]["incomplete"], len(EXAMPLES))
        self.assertTrue(all("ValueError" in r["failure"] for r in result["rows"]))


class SheetEvalTest(unittest.TestCase):
    def test_judge_counts_low_confidence_pairs_as_incomplete(self):
        gold = [gold_unit("M1-1", "DB = SQLite", "박지민"), gold_unit("M2-1", "DB = MySQL", "이서준")]
        pairs = [{"pair_id": "K1", "old_unit": "M1-1", "new_unit": "M2-1", "old_text": "", "new_text": "", "label": "충돌"}]
        result = sheet_eval.eval_judge(gold, pairs, None, UNSURE)
        self.assertEqual((result["incomplete"], result["rows"][0]["ok"]), (1, False))

    def test_e2e_compares_pair_by_pair_beyond_the_synchronous_limit(self):
        preds = [(f"M{i}", {**dec(f"M{i}#{i}", "DB", f"DB = {i}"), "status": "approved"}) for i in range(35)]
        pairs = [{"pair_id": "K1", "old_unit": "M0-1", "new_unit": "M34-1", "label": "충돌"}]
        result = sheet_eval.eval_e2e(preds, pairs, None, None)  # 규칙 판정: 결정자 모름 → 충돌
        self.assertEqual(result["incomplete_pairs"], 0)
        self.assertEqual(result["total_alerts"], 35 * 34 // 2)
        self.assertEqual(result["detection_rate"], 1.0)

    def test_e2e_leaves_failed_pairs_out_of_the_rates(self):
        # 판정 실패(낮은 확신도)와 분류 실패 세션의 쌍은 '놓친 경고'가 아니라 미완료다 (코드 지도 지적, 감지율이 낮게 나옴)
        preds = [(f"M{i}", {**dec(f"M{i}#{i}", "DB", f"DB = {i}"), "status": "approved"}) for i in range(2)]
        pairs = [{"pair_id": "K1", "old_unit": "M0-1", "new_unit": "M1-1", "label": "충돌"},
                 {"pair_id": "K2", "old_unit": "M0-1", "new_unit": "M9-1", "label": "충돌"}]
        result = sheet_eval.eval_e2e(preds, pairs, None, UNSURE, unclassified={"M9"})
        self.assertEqual(result["incomplete_pairs"], 2)
        self.assertEqual(result["detection_rate"], 0.0)  # 채점할 쌍이 없어 0/0
        self.assertEqual([r["incomplete"] for r in result["rows"]], [True, True])

    def test_ai_judging_does_not_fall_back_to_rules(self):
        # chat 답에 그 쌍이 없으면 AI 평가는 규칙으로 채우지 않고 미완료로 센다 (--rule 기준선만 규칙)
        class Empty:
            def chat_json(self, system, user):
                return {"results": []}
        gold = [gold_unit("M1-1", "DB = SQLite", "박지민"), gold_unit("M2-1", "DB = MySQL", "이서준")]
        pairs = [{"pair_id": "K1", "old_unit": "M1-1", "new_unit": "M2-1", "old_text": "", "new_text": "", "label": "충돌"}]
        self.assertEqual(sheet_eval.eval_judge(gold, pairs, Empty(), None)["incomplete"], 1)
        self.assertEqual(sheet_eval.eval_judge(gold, pairs, None, None)["incomplete"], 0)


if __name__ == "__main__":
    unittest.main()
