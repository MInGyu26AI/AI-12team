"""외부 AI 없이 도는 테스트 (가짜 LLM 이 정해진 JSON 을 돌려줌).  python3 -m unittest -v"""
import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from syncup_ai import batch, conflict
from syncup_ai.classify import classify, handle_request
from syncup_ai.llm import DecisionsResponseError, parse_json_reply
from syncup_ai.mask import mask
from syncup_ai.schema import normalize_card, validate_output
from tests.fakes import CTX, FakeDecider, FakeLLM, dec, default_answer, msg


class ClassifyTest(unittest.TestCase):
    def run_cls(self, messages, cards, **ctx):
        llm = FakeLLM({"cards": cards})
        return classify({"context": {**CTX, **ctx}, "messages": messages}, llm), llm

    def test_masks_before_sending_and_source(self):
        cards, llm = self.run_cls(
            [msg(1, "발표 자료는 010-1234-5678로 보내 줘.")],
            [{"msg": 1, "relevance": "related", "sentence": "발표 자료는 [연락처]로 보내 줘.", "subtopic": "발표·제출",
              "tag": "todo", "topic_key": "발표 자료", "content": "발표 자료 전달", "owner": None, "confidence": 0.85}],
        )
        self.assertNotIn("010-1234-5678", llm.prompts[0])  # 외부 AI 로 원문 번호가 안 감
        c = cards[0]
        self.assertTrue(c["masked"])
        self.assertEqual(c["source"], "ChatGPT, 2026-11-06 21:10")  # KST
        self.assertLess(c["confidence"], 0.6)  # 담당 미정 → 확인 필요
        self.assertEqual(validate_output(c), [])

    def test_personal_drops_content(self):
        cards, _ = self.run_cls([msg(1, "오늘 점심 김밥 먹었어.")],
                                [{"msg": 1, "relevance": "personal", "sentence": "오늘 점심 김밥", "confidence": 0.9}])
        self.assertEqual(set(cards[0]), {"relevance", "source", "masked", "confidence"})

    def test_split_topic_reuse_and_fixups(self):
        cards, _ = self.run_cls(
            [msg(1, "서비스명은 싱크업으로 하고, 기준표는 내가 내일까지 만들게.")],
            [
                {"msg": 1, "relevance": "related", "sentence": "서비스명은 싱크업으로 하고,", "subtopic": "주제 · 목표",
                 "tag": "결정", "topic_key": "서비스 명", "content": "서비스명 = 싱크업", "owner": "김단비",
                 "is_change": False, "due": "2026-11-07", "confidence": 1.4},
                {"msg": 1, "relevance": "related", "sentence": "기준표는 내가 내일까지 만들게.", "subtopic": "역할·일정",
                 "tag": "todo", "topic_key": "분류 기준", "content": "분류 기준표 만들기", "owner": "김단비",
                 "due": "2026-11-07", "is_change": True, "confidence": 0.85},
            ],
        )
        a, b = cards
        self.assertEqual((a["subtopic"], a["tag"], a["topic_key"], a["is_new_topic"]), ("주제·목표", "decision", "서비스명", False))
        self.assertIsNone(a["due"])  # 결정에는 기한 없음
        self.assertEqual(a["confidence"], 1.0)
        self.assertEqual((b["due"], b["is_change"], b["is_new_topic"]), ("2026-11-07", False, True))
        for c in cards:
            self.assertEqual(validate_output(c), [])

    def test_card_for_message_number_out_of_range_is_dropped(self):
        cards, _ = self.run_cls(
            [msg(2, "React로 만드세요.", role="assistant")],
            [{"msg": 1, "relevance": "related", "sentence": "React로 만드세요.", "tag": "decision", "subtopic": "기타",
              "topic_key": "x", "content": "x"},
             {"msg": 2, "relevance": "related", "sentence": "React로 만드세요.", "tag": "decision"}])
        self.assertEqual(len(cards), 1)  # 발화가 하나라 msg 2 는 없는 번호

    def test_context_message_is_shown_but_ai_speaker_cannot_decide(self):
        req = {"context": CTX, "messages": [msg(2, "React로 만드세요.", role="assistant")], "contextMessages": [msg(1, "뭐로 만들까?")]}
        llm = FakeLLM({"cards": [
            {"msg": 1, "relevance": "related", "sentence": "뭐로 만들까?", "tag": "none", "content": "질문"},
            {"msg": 2, "relevance": "related", "sentence": "React로 만드세요.", "tag": "decision", "subtopic": "작업·결과물",
             "topic_key": "프레임워크", "content": "프레임워크 = React", "owner": "AI", "confidence": 0.8}]})
        cards = classify(req, llm)
        self.assertIn("[1] [참고용]", llm.prompts[0])
        self.assertEqual(len(cards), 1)  # 참고용 발화 카드는 버림
        self.assertEqual((cards[0]["tag"], cards[0]["owner"]), ("none", None))  # AI 말은 제안

    def test_disabled_subtopic_becomes_etc(self):
        cards, _ = self.run_cls([msg(1, "발표는 유나가 하자.")],
                                [{"msg": 1, "relevance": "related", "sentence": "발표는 유나가 하자.", "subtopic": "발표·제출",
                                  "tag": "todo", "topic_key": "발표 담당", "content": "발표 = 최유나", "owner": "최유나"}],
                                enabledSubtopics=["주제·목표", "역할·일정", "기타"])
        self.assertEqual(cards[0]["subtopic"], "기타")

    def test_bad_reply_gives_error_response(self):
        res = handle_request({"context": CTX, "messages": [msg(1, "x")]}, FakeLLM({"oops": 1}))
        self.assertFalse(res["ok"])

    def test_parse_json_reply_with_fence(self):
        self.assertEqual(parse_json_reply('결과입니다\n```json\n{"cards": []}\n```'), {"cards": []})
        self.assertEqual(parse_json_reply('[{"msg": 1}]'), {"cards": [{"msg": 1}]})


class BatchTest(unittest.TestCase):
    def test_turns_and_flush(self):
        ms = []
        for i in range(12):
            ms += [msg(2 * i, f"q{i}"), msg(2 * i + 1, f"a{i}", role="assistant")]
        ms.append(msg(99, "답 기다리는 질문"))
        batches, left = batch.take_ready_batches(ms, turns_per_batch=10)
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 20)
        self.assertEqual(len(left), 5)  # 2턴(4발화) + 답 없는 질문
        batches, left = batch.take_ready_batches(left, turns_per_batch=10, flush=True)
        self.assertEqual((len(batches), left), (1, []))

    def test_new_conversation_starts_new_turn(self):
        turns = batch.group_turns([msg(1, "q"), msg(2, "a", role="assistant", conv="c2")])
        self.assertEqual(len(turns), 2)

    def test_turn_id_groups_and_complete_user_message_is_ready(self):
        a, b, c = ({**msg(i, "x"), "turnId": t, "complete": True} for i, t in ((1, "t1"), (2, "t1"), (3, "t2")))
        self.assertEqual([len(t) for t in batch.group_turns([a, b, c])], [2, 1])  # 사용자 발화끼리도 같은 turnId 면 한 턴
        batches, left = batch.take_ready_batches([a, b, c], turns_per_batch=2)
        self.assertEqual((len(batches), left), (1, []))  # complete 인 마지막 사용자 발화는 답을 기다리지 않음


class ConflictTest(unittest.TestCase):
    def test_rule_fallback(self):
        old = dec("a", "타깃", "타깃 = 대학생")
        judged, conflicts = conflict.check_new_decision(dec("b", "타깃", "타깃 = 직장인"), [old])
        self.assertEqual(judged[0]["judgement"], "충돌")
        self.assertEqual((conflicts[0]["cardA"]["id"], conflicts[0]["cardB"]["id"]), ("a", "b"))

    def test_ai_judge_and_missing_result(self):
        old1, old2 = dec("a", "MVP 범위", "브라우저 확장 = 행사 이후"), dec("c", "MVP 범위", "웹 = MVP 포함")
        llm = FakeLLM({"results": [{"id": "a", "judgement": "변경", "reason": "행사 이후 → MVP 포함", "confidence": .9}]})
        judged, conflicts = conflict.check_new_decision(dec("b", "MVP 범위", "브라우저 확장 = MVP 포함", True), [old1, old2], llm)
        self.assertEqual({j["id"]: j["judgement"] for j in judged}, {"a": "변경", "c": "충돌"})  # c 는 규칙으로 채움 (결정자 모름 → 충돌)
        by_old = {c["cardA"]["id"]: c for c in conflicts}
        self.assertEqual(by_old["a"]["reason"], "행사 이후 → MVP 포함")

    def test_chat_reason_missing_uses_text_for_its_own_judgement(self):
        old, new = dec("a", "타깃", "타깃 = 대학생"), dec("b", "타깃", "타깃은 대학생")
        llm = FakeLLM({"results": [{"id": "a", "judgement": "같음", "confidence": .9}]})
        judged, _ = conflict.check_new_decision(new, [old], llm)
        self.assertEqual(judged[0]["reason"], "기존 결정 '타깃 = 대학생'과(와) 같은 내용")  # 규칙의 '다른 내용' 문구가 아니다

    def test_non_decision_skipped_and_batch_compares_new_cards(self):
        todo = {**dec("t", "타깃", "x"), "tag": "todo"}
        res = conflict.handle_request({"newCards": [todo, dec("b1", "타깃", "타깃 = 대학생"), dec("b2", "타깃", "타깃 = 직장인")],
                                       "existing": []}, None)
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["conflicts"]), 1)


class OwnerRuleTest(unittest.TestCase):
    def test_same_owner_or_team_agreement_is_change(self):
        old = {**dec("a", "회의 시간", "회의 = 밤 10시"), "owner": "박지민"}
        same = {**dec("b", "회의 시간", "회의 = 밤 11시"), "owner": "박지민"}
        other = {**dec("c", "회의 시간", "회의 = 밤 9시"), "owner": "이서준"}
        team = {**dec("d", "회의 시간", "회의 = 밤 8시"), "owner": "이서준", "sentence": "팀에서 8시로 하기로 했어"}
        self.assertEqual(conflict.rule_judge(same, old)["judgement"], "변경")
        self.assertEqual(conflict.rule_judge(other, old)["judgement"], "충돌")
        self.assertEqual(conflict.rule_judge(team, old)["judgement"], "변경")


class DecisionsTest(unittest.TestCase):
    def test_relabel_overrides_labels_and_confidence(self):
        llm = FakeLLM({"cards": [
            {"msg": 1, "relevance": "related", "sentence": "FastAPI 기준으로 코드 짜 줘.", "tag": "none", "content": "코드 요청"},
            {"msg": 1, "relevance": "related", "sentence": "오늘 피곤하다", "tag": "research", "subtopic": "기타", "topic_key": "컨디션", "content": "피곤"},
        ]})
        answers = {
            "u1_rel": {"type": "choice", "name": "u1_rel", "choice": "related", "confidence": 0.95},
            "u1_tag": {"type": "choice", "name": "u1_tag", "choice": "decision", "confidence": 0.55},
            "u1_sub": {"type": "choice", "name": "u1_sub", "choice": "작업·결과물", "confidence": 0.9},
            "u1_chg": {"type": "predicate", "name": "u1_chg", "probability": 0.1},
            "u2_rel": {"type": "choice", "name": "u2_rel", "choice": "personal", "probabilities": [{"value": "personal", "probability": 0.8}]},
        }
        d = FakeDecider(lambda q: answers.get(q["name"]))
        cards = classify({"context": CTX, "messages": [msg(1, "FastAPI 기준으로 코드 짜 줘. 오늘 피곤하다")]}, llm, d)
        a, b = cards
        self.assertEqual((a["tag"], a["subtopic"], a["is_change"], a["confidence"]), ("decision", "작업·결과물", False, 0.55))
        self.assertEqual(validate_output(a), [])
        self.assertEqual(set(b), {"relevance", "source", "masked", "confidence"})
        self.assertEqual(b["confidence"], 0.8)
        self.assertEqual(len(d.calls[0][1]), 8)  # 문장 2개 × 질문 4개

    def test_personal_relabel_keeps_zero_confidence(self):
        llm = FakeLLM({"cards": [{"msg": 1, "relevance": "related", "sentence": "오늘 피곤하다", "tag": "research",
                                  "subtopic": "기타", "topic_key": "컨디션", "content": "피곤"}]})
        d = FakeDecider(lambda q: {"type": "choice", "name": q["name"], "choice": "personal", "confidence": 0.0} if q["name"] == "u1_rel" else None)
        [card] = classify({"context": CTX, "messages": [msg(1, "오늘 피곤하다")]}, llm, d)
        self.assertEqual((card["relevance"], card["confidence"]), ("personal", 0.0))  # 0 이 0.5 로 바뀌면 안 된다

    def test_missing_answer_or_confidence_fails_instead_of_keeping_chat_label(self):
        llm = FakeLLM({"cards": [{"msg": 1, "relevance": "related", "sentence": "타깃은 대학생으로 가자.", "tag": "decision",
                                  "subtopic": "주제·목표", "topic_key": "타깃", "content": "타깃 = 대학생", "owner": "김단비"}]})
        request = {"context": CTX, "messages": [msg(1, "타깃은 대학생으로 가자.")]}

        class Partial:  # 표시(_tag) 답만 빠진 응답
            def decide(self, text, questions):
                return {q["name"]: default_answer(q) for q in questions if not q["name"].endswith("_tag")}

        personal_without_confidence = FakeDecider(
            lambda q: {"type": "choice", "name": q["name"], "choice": "personal"} if q["name"] == "u1_rel" else None)
        tag_without_choice = FakeDecider(
            lambda q: {"type": "choice", "name": q["name"], "confidence": 0.9} if q["name"] == "u1_tag" else None)
        related_without_confidence = FakeDecider(
            lambda q: {"type": "choice", "name": q["name"], "choice": "related"} if q["name"] == "u1_rel" else None)
        for decider in (Partial(), personal_without_confidence, tag_without_choice, related_without_confidence):
            with self.subTest(decider=type(decider).__name__), self.assertRaises(DecisionsResponseError):
                classify(request, llm, decider)

    def test_decider_failure_keeps_chat_labels(self):
        class Boom:
            def decide(self, *a): raise RuntimeError("403")
        llm = FakeLLM({"cards": [{"msg": 1, "relevance": "related", "sentence": "타깃은 대학생으로 가자.", "tag": "decision",
                                  "subtopic": "주제·목표", "topic_key": "타깃", "content": "타깃 = 대학생", "owner": "김단비", "confidence": 0.9}]})
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            cards = classify({"context": CTX, "messages": [msg(1, "타깃은 대학생으로 가자.")]}, llm, Boom())
        self.assertEqual((cards[0]["tag"], cards[0]["confidence"]), ("decision", 0.9))
        self.assertEqual(log.getvalue(), "[syncup_ai] Decisions 라벨 실패, chat 라벨 사용: RuntimeError\n")

    def test_conflict_judged_by_decider(self):
        old = {**dec("a", "타깃", "타깃 = 대학생"), "owner": "박지민"}
        new = {**dec("b", "타깃", "타깃 = 직장인"), "owner": "이서준"}
        d = FakeDecider(lambda q: {"type": "choice", "name": q["name"], "choice": "충돌", "confidence": 0.87})
        judged, conflicts = conflict.check_new_decision(new, [old], decider=d)
        self.assertEqual((judged[0]["judgement"], judged[0]["confidence"]), ("충돌", 0.87))
        self.assertIn("박지민", conflicts[0]["reason"])


SECRETS = ["sk-proj-AbCdEf0123456789_xyz-QRSTuvwx", "ghp_1234567890abcdefGHIJKLmnopqrstuvWXYZ",
           "Xy3_kL9-pQ2rT7uV1wZ5aB8cD4eF6gH0iJ2kL4mN6oP"]
LEAK = ("AbCdEf0123", "QRSTuvwx", "ghp_", "WXYZ", "Xy3_kL9", "mN6oP")


class MaskTest(unittest.TestCase):
    def test_shared_cases(self):
        """shared/mask-cases.json — TypeScript(shared/classify.ts)도 같은 파일로 검사"""
        cases = json.loads((Path(__file__).resolve().parents[2] / "shared/mask-cases.json").read_text(encoding="utf-8"))["cases"]
        for c in cases:
            with self.subTest(c["name"]):
                out, masked = mask(c["input"])
                for a in c["absent"]:
                    self.assertNotIn(a, out)
                for x in c["present"]:
                    self.assertIn(x, out)
                self.assertEqual(masked, c["masked"])

    def assertNoLeak(self, text):
        for frag in LEAK:
            self.assertNotIn(frag, text)

    def test_classify_request_and_card(self):
        text = f"OpenAI 키 {SECRETS[0]} 랑 Authorization: Bearer {SECRETS[2]} 로 서버 붙이자"
        ctx = {**CTX, "existingDecisions": [{"topic_key": "서버 인증", "content": f"토큰 = {SECRETS[1]}"}]}
        llm = FakeLLM({"cards": [{"msg": 1, "relevance": "related", "sentence": text, "subtopic": "작업·결과물",
                                  "tag": "decision", "topic_key": "서버 인증", "content": f"인증 = Bearer {SECRETS[2]}",
                                  "owner": "김단비"}]})
        d = FakeDecider()
        cards = classify({"context": ctx, "messages": [msg(1, text)]}, llm, d)
        self.assertNoLeak(llm.prompts[0])  # 발화 + 기존 결정까지
        self.assertNoLeak(d.calls[0][0])   # Decisions 로 가는 본문
        self.assertNoLeak(json.dumps(cards, ensure_ascii=False))  # 모델이 원문을 되돌려 줘도 카드에 안 남음
        self.assertTrue(cards[0]["masked"])

    def test_card_masks_value_exposed_by_the_first_pass(self):
        # 첫 가림이 주민번호를 바꾼 뒤에야 바로 붙은 토큰의 경계가 생긴다. normalize_card 는 문장을 두 번 가려 이것도 지운다.
        raw = {"relevance": "related", "sentence": f"900101-1234567{SECRETS[1]} 로 푸시하자", "tag": "decision",
               "subtopic": "작업·결과물", "topic_key": "배포", "content": "배포 = 푸시", "owner": "김단비"}
        card = normalize_card(raw, source="ChatGPT", pre_masked=False, existing_topics=[])
        self.assertEqual((card["sentence"], card["masked"]), ("[주민번호][액세스토큰] 로 푸시하자", True))

    def test_token_choice_order_differs_between_quoted_and_plain_values(self):
        # 가림 규칙 고정: 따옴표 값은 비밀번호를, 따옴표 없는 값은 API키를 먼저 본다 (mask.py 의 두 함수)
        self.assertEqual(mask("api_key_password='v a l'")[0], "api_key_password='[비밀번호]'")
        self.assertEqual(mask("api_key_password=secretvalue")[0], "api_key_password=[API키]")

    def test_conflict_requests(self):
        old = {**dec("a", "서버 인증", f"인증 = {SECRETS[0]}"), "owner": "김동균"}
        new = {**dec("b", "서버 인증", "인증 = 토큰"), "owner": "김하은",
               "sentence": f'"access_token": "{SECRETS[2]}" 으로 바꾸자'}  # 검토함에서 사용자가 고친 문장
        llm = FakeLLM({"results": [{"id": "a", "judgement": "충돌", "reason": "x", "confidence": 0.9}]})
        conflict.check_new_decision(new, [old], llm)
        self.assertNoLeak(llm.prompts[0])
        d = FakeDecider(lambda q: {"type": "choice", "name": q["name"], "choice": "충돌", "confidence": 0.9})
        conflict.check_new_decision(new, [old], decider=d)
        self.assertNoLeak(d.calls[0][0])


class CliTest(unittest.TestCase):
    def test_classify_without_key_returns_ok_false(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("AI_")}
        env.update(AI_BASE_URL="", AI_API_KEY="", AI_MODEL="", AI_DECISIONS_MODEL="", OPENAI_API_KEY="")
        p = subprocess.run([sys.executable, "-m", "syncup_ai", "classify"], input=json.dumps({"context": CTX, "messages": [msg(1, "x")]}),
                           capture_output=True, text=True, env=env)
        self.assertFalse(json.loads(p.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
