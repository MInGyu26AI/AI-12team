"""Synthetic boundary checks: no API key or external requests."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

from syncup_ai import classify, conflict
from syncup_ai.llm import DecisionsClient, LLMError, RetryableLLMError, choice_q, predicate_q
from tests.fakes import CTX, FakeDecider, FakeLLM, dec, msg
from tests.loopback import Reply, loopback_server

TARGET = '타깃은 대학생으로 가자.'


def chat_decision():
    """TARGET 발화를 결정 카드 한 장으로 분류하는 가짜 chat 모델."""
    return FakeLLM({'cards': [dict(msg=1, relevance='related', sentence=TARGET, tag='decision',
                   subtopic='주제·목표', topic_key='타깃', content='타깃 = 대학생', owner='김단비', confidence=.9)]})


class DecisionsValidationTest(unittest.TestCase):
    def setUp(self):
        self.client = DecisionsClient('http://unused.invalid', 'synthetic-key')
        self.questions = [choice_q('q', 'Choose', {'a': 'A', 'b': 'B'})]
        self.answer = dict(type='choice', name='q', choice='a', confidence=.6,
                           probabilities=[dict(value='a', probability=.8), dict(value='b', probability=.2)])

    def call(self, response, questions=None):
        with patch('syncup_ai.llm._post', return_value=response) as post:
            result = self.client.decide('synthetic', self.questions if questions is None else questions)
            self.assertEqual(post.call_count, 1)
            return result

    def rejected(self, response, questions=None):
        with patch('syncup_ai.llm._post', return_value=response) as post:
            with self.assertRaises(LLMError) as caught:
                self.client.decide('synthetic', self.questions if questions is None else questions)
            self.assertNotIsInstance(caught.exception, RetryableLLMError)
            self.assertEqual(post.call_count, 1)

    def test_valid_and_legacy_optional_fields(self):
        for omitted in (None, 'confidence', 'probabilities'):
            answer = copy.deepcopy(self.answer)
            if omitted:
                answer.pop(omitted)
            self.assertEqual(self.call({'answers': [answer]})['q'], answer)
        second = dict(type='predicate', name='p', probability=.5)
        result = self.call({'answers': [second, self.answer]}, self.questions + [predicate_q('p', 'P')])
        self.assertEqual(set(result), {'q', 'p'})

    def test_envelope_identity_and_refusal(self):
        for response in (None, [], {}, {'answers': None}, {'answers': {}}, {'answers': []},
                         {'answers': [None]}, {'answers': [self.answer, self.answer]}):
            with self.subTest(response=response):
                self.rejected(response)
        for changes in ({'name': 'other'}, {'name': None}, {'name': []}, {'type': 'predicate'},
                        {'type': 'refusal'}, {'choice': 'other'}, {'choice': []}, {'choice': True}):
            with self.subTest(changes=changes):
                self.rejected({'answers': [{**self.answer, **changes}]})
        for missing in ('name', 'type', 'choice'):
            answer = dict(self.answer)
            answer.pop(missing)
            self.rejected({'answers': [answer]})

    def test_confidence_is_finite_numeric_probability(self):
        for value in (None, True, '0.9', -0.01, 1.01, float('nan'), float('inf'), float('-inf')):
            with self.subTest(value=value):
                self.rejected({'answers': [{**self.answer, 'confidence': value}]})
        self.rejected({'answers': [dict(type='choice', name='q', choice='a')]})

    def test_probability_distribution_shape_and_consistency(self):
        for probabilities in (None, {}, [], [None], [{'value': 'a'}],
                [dict(value='a', probability=.8)],
                [dict(value='a', probability=.8), dict(value='a', probability=.2)],
                [dict(value='a', probability=.8), dict(value='x', probability=.2)],
                [dict(value='a', probability=.8), dict(value='b', probability=.8)]):
            with self.subTest(probabilities=probabilities):
                self.rejected({'answers': [{**self.answer, 'probabilities': probabilities}]})
        for value in (None, True, '0.2', -0.1, 1.1, float('nan'), float('inf')):
            answer = copy.deepcopy(self.answer)
            answer['probabilities'][1]['probability'] = value
            self.rejected({'answers': [answer]})
        self.rejected({'answers': [{**self.answer, 'choice': 'b'}]})
        answer = copy.deepcopy(self.answer)
        answer['probabilities'][1]['value'] = []
        self.rejected({'answers': [answer]})

    def test_predicate_and_typed_boolean_choice(self):
        question = predicate_q('p', 'Is it?')
        for value in (0, .5, 1):
            self.call({'answers': [dict(type='predicate', name='p', probability=value)]}, [question])
        for value in (None, True, '0.5', -1, 2, float('nan'), float('inf')):
            self.rejected({'answers': [dict(type='predicate', name='p', probability=value)]}, [question])
        question = choice_q('q', 'Choose', {True: 'yes', 'true': 'text'})
        answer = dict(type='choice', name='q', choice=True, confidence=.7,
                      probabilities=[dict(value=True, probability=.7), dict(value='true', probability=.3)])
        self.call({'answers': [answer]}, [question])
        self.rejected({'answers': [{**answer, 'choice': 1}]}, [question])

    def test_score_questions_are_rejected_before_request(self):
        question = dict(name='s', type='score', instructions='Rate', levels=[{'label': 'low'}, {'label': 'high'}])
        with patch('syncup_ai.llm._post') as post:
            with self.assertRaises(LLMError):
                self.client.decide('synthetic', [question])
            post.assert_not_called()

    def test_chunk_names_and_atomic_failure(self):
        self.client.MAX_QUESTIONS = 1
        questions = [predicate_q('a', 'A'), predicate_q('b', 'B')]
        first = dict(type='predicate', name='a', probability=.9)
        second = dict(type='predicate', name='b', probability=.8)
        with patch('syncup_ai.llm._post', side_effect=[{'answers': [first]}, {'answers': [second]}]):
            self.assertEqual(set(self.client.decide('synthetic', questions)), {'a', 'b'})
        with patch('syncup_ai.llm._post', side_effect=[{'answers': [first]}, {'answers': [first]}]) as post:
            with self.assertRaises(LLMError):
                self.client.decide('synthetic', questions)
            self.assertEqual(post.call_count, 2)
        with patch('syncup_ai.llm._post') as post:
            with self.assertRaises(LLMError):
                self.client.decide('synthetic', [questions[0], questions[0]])
            post.assert_not_called()

    def test_conflict_failure_does_not_fallback_or_retry(self):
        chat = Mock()
        with patch('syncup_ai.llm._post', return_value={'answers': [dict(type='refusal', name='e1')]}) as post:
            result = conflict.handle_request({'newCards': [dec('new', 'UI', '화면 = Vue')],
                                              'existing': [dec('old', 'UI', '화면 = React')]},
                                             chat, decider=self.client, allow_rules=True)
        self.assertEqual((result['ok'], result['checkStatus'], result['failureReason'], result['retryable']),
                         (False, 'failed', 'check-failed', False))
        self.assertNotIn('results', result)
        self.assertNotIn('conflicts', result)
        self.assertEqual(post.call_count, 1)
        chat.chat_json.assert_not_called()

    def test_classification_does_not_hide_malformed_response(self):
        for response in ({'answers': []}, {'answers': [dict(type='refusal', name='u1_rel')]}):
            with patch('syncup_ai.llm._post', return_value=response) as post:
                result = classify.handle_request({'context': CTX, 'messages': [msg(1, TARGET)]},
                                                 chat_decision(), self.client)
            self.assertFalse(result['ok'])
            self.assertNotIn('cards', result)
            self.assertEqual(post.call_count, 1)

    def test_turned_off_subtopic_can_still_go_to_other(self):
        # 주제·목표와 기타를 끄고 역할·일정만 켜 둠: 주제·목표 발화는 켜 둔 역할·일정이 아니라 기타로 가야 한다
        decider = FakeDecider(lambda q: dict(type='choice', name=q['name'], choice='기타', confidence=.9)
                              if q['name'] == 'u1_sub' else None)
        request = {'context': {**CTX, 'enabledSubtopics': ['역할·일정']}, 'messages': [msg(1, TARGET)]}
        cards = classify.classify(request, chat_decision(), decider)
        choices = next(q['choices'] for q in decider.calls[0][1] if q['name'] == 'u1_sub')
        self.assertEqual([c['value'] for c in choices], ['역할·일정', '기타'])
        self.assertEqual((cards[0]['subtopic'], cards[0]['classificationMethod']), ('기타', 'decisions'))

    def test_classification_http_failure_logs_only_error_type_and_status(self):
        # 오류 본문이 키와 요청 원문을 그대로 돌려줘도, 로그 줄에는 예외 종류와 HTTP 상태만 남는다
        reply = Reply(403, f'{{"error": "bad key synthetic-key for {TARGET}"}}'.encode())
        log = io.StringIO()
        with loopback_server(reply) as origin, contextlib.redirect_stderr(log):
            self.client.base_url = origin
            cards = classify.classify({'context': CTX, 'messages': [msg(1, TARGET)]}, chat_decision(), self.client)
        self.assertEqual(log.getvalue(), '[syncup_ai] Decisions 라벨 실패, chat 라벨 사용: LLMError HTTP 403\n')
        self.assertEqual((cards[0]['tag'], cards[0]['classificationMethod']), ('decision', 'chat'))
        self.assertEqual(len(reply.requests), 1)

    def test_real_http_and_cli_keep_invalid_responses_failed(self):
        reply = Reply()
        with loopback_server(reply) as origin:
            base = f'{origin}/v1'
            self.client.base_url = base
            for body in (b'not-json', b'\xff', b'{"answers": []}'):
                reply.body = body
                with self.assertRaises(LLMError) as caught:
                    self.client.decide('synthetic', self.questions)
                self.assertNotIsInstance(caught.exception, RetryableLLMError)
            self.assertEqual(len(reply.requests), 3)
            env = {k: v for k, v in os.environ.items() if not k.startswith(('AI_', 'OPENAI_'))}
            env.update(PYTHONPATH=str(Path(__file__).resolve().parents[1]), AI_BASE_URL=base,
                       AI_API_KEY='synthetic-key', AI_MODEL='synthetic-chat', AI_DECISIONS_MODEL='synthetic-decisions')
            request = {'newCards': [dec('new', 'UI', '화면 = Vue')],
                       'existing': [dec('old', 'UI', '화면 = React')]}
            decisions_only, with_review = ['/v1/decisions'], ['/v1/decisions', '/v1/chat/completions']
            # (Decisions 답, 성공 여부, 서버가 받은 경로). 낮은 확신도는 chat 독립 검토를 한 번 부른다.
            # 이 서버는 chat 경로에도 Decisions 응답을 돌려주므로 검토는 형식 오류로 끝나고 확인 필요로 남는다.
            for answer, expected, paths in (
                    (dict(type='refusal', name='e1'), False, decisions_only),
                    (dict(type='choice', name='e1', choice='충돌', confidence=.6), True, decisions_only),
                    (dict(type='choice', name='e1', choice='충돌', confidence=.5999), False, with_review)):
                reply.body = json.dumps({'answers': [answer]}).encode()
                before = len(reply.requests)
                process = subprocess.run([sys.executable, '-m', 'syncup_ai', 'conflicts'],
                    input=json.dumps(request), text=True, capture_output=True, env=env, timeout=10)
                result = json.loads(process.stdout)
                self.assertEqual(process.returncode, 0 if expected else 1, process.stderr)
                self.assertEqual(result['ok'], expected)
                self.assertEqual([path for path, _ in reply.requests[before:]], paths)
                if not expected:
                    self.assertEqual(result['checkStatus'], 'failed')
                    self.assertFalse(result['retryable'])


if __name__ == '__main__':
    unittest.main()
