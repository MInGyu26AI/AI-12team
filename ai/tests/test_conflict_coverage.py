"""Coverage and completion contracts; scripted answers do not measure model accuracy."""
import re
import unittest
from unittest.mock import patch

from syncup_ai import config, conflict
from syncup_ai.decide import judge_pairs
from syncup_ai.similarity import similarities
from syncup_ai.llm import RetryableLLMError
from tests.test_ai import dec, FakeLLM


class RecordingDecider:
    def __init__(self, choices=None, fail_at=None, transport_failure=False):
        self.choices = choices or {}
        self.fail_at = fail_at
        self.transport_failure = transport_failure
        self.calls = []

    def decide(self, text, questions):
        self.calls.append((text, questions))
        if len(self.calls) == self.fail_at:
            if self.transport_failure:
                raise RetryableLLMError('synthetic transport failure')
            return {}  # refusal/missing answers must not mean no conflict
        lines = dict(re.findall(r'^(e\d+): (.*)$', text, re.M))
        return {q['name']: {'choice': next((choice for marker, choice in self.choices.items()
                                          if marker in lines[q['name']]), '무관'),
                            'confidence': .9} for q in questions}


@patch.object(config, 'CONFLICT_TOP_K', 3)
class CoverageTest(unittest.TestCase):
    def test_low_similarity_and_rank_after_three_reach_decisions(self):
        new = dec('new', 'DB', 'DB = PG')
        matching = dec('postgres', '데이터 저장소', '데이터 저장소 = PostgreSQL')
        self.assertLess(similarities(new, [matching])[0], 0.35)  # 예전 SIMILARITY_MIN: 이 값 아래도 이제 비교한다
        old = [dec(str(i), 'DB', f'로컬 캐시 {i} = SQLite') for i in range(3)] + [matching]
        decider = RecordingDecider({'PostgreSQL': '같음'})
        result = conflict.handle_request({'newCards': [new], 'existing': old}, None,
                                         decider=decider, allow_rules=False)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['checkStatus'], 'complete')
        self.assertEqual([len(qs) for _, qs in decider.calls], [3, 1])
        self.assertNotIn('PostgreSQL', decider.calls[0][0])
        self.assertIn('PostgreSQL', decider.calls[1][0])
        judged = result['results'][0]['judgements']
        self.assertEqual({j['id'] for j in judged}, {c['id'] for c in old})
        self.assertEqual(next(j for j in judged if j['id'] == 'postgres')['judgement'], '같음')
        self.assertFalse(result['conflicts'])
        self.assertTrue(all(j['method'] == 'decisions' for j in judged))

    def test_semantic_results_override_keys_and_keep_four_relations(self):
        new = {**dec('new', '프론트엔드', '웹 화면 = Vue'), 'owner': '가상사용자B'}
        old = [dec('different_key', '프레임워크', '웹 화면 = React'),
               dec('same_key', '프론트엔드', '아이콘 = 원형'),
               dec('change', 'UI 기술', '팀 합의 전 웹 화면 = Svelte'),
               dec('same', '화면 기술', '웹 화면 = Vue')]
        decider = RecordingDecider({'React': '충돌', '원형': '무관', 'Svelte': '변경', '= Vue': '같음'})
        result = conflict.handle_request({'newCards': [new], 'existing': old}, None,
                                         decider=decider, allow_rules=False)
        self.assertTrue(result['ok'], result)
        self.assertEqual({j['id']: j['judgement'] for j in result['results'][0]['judgements']},
                         {'different_key': '충돌', 'same_key': '무관', 'change': '변경', 'same': '같음'})
        self.assertEqual({c['cardA']['id'] for c in result['conflicts']}, {'different_key', 'change'})
        for _, questions in decider.calls:
            self.assertIn('최종적으로 채택한 값', questions[0]['instructions'])

    def test_empty_key_is_not_a_silent_skip(self):
        decider = RecordingDecider()
        judged, _ = conflict.check_new_decision(dec('new', '', '웹 화면 = Vue'),
                        [dec('old', 'UI', '웹 화면 = React')], decider=decider, allow_rules=False)
        self.assertEqual(len(judged), 1)
        self.assertEqual(len(decider.calls), 1)

    def test_decisions_receives_original_reason_and_scope(self):
        old = {**dec('old', 'DB', '시연 = SQLite'), 'reason': '운영 이전 단계'}
        decider = RecordingDecider()
        judge_pairs(dec('new', 'DB', '운영 = PostgreSQL'), [old], decider)
        self.assertIn('운영 이전 단계', decider.calls[0][0])
        self.assertIn('시연 = SQLite', decider.calls[0][0])

    def test_missing_late_batch_fails_without_partial_success(self):
        old = [dec(str(i), 'DB', f'DB = {i}') for i in range(4)]
        decider = RecordingDecider({'DB =': '충돌'}, fail_at=2)
        result = conflict.handle_request({'newCards': [dec('new', 'DB', 'x')], 'existing': old},
                                         None, decider=decider, allow_rules=False)
        self.assertEqual((result['ok'], result['checkStatus']), (False, 'failed'))
        self.assertNotIn('conflicts', result)
        self.assertNotIn('results', result)
        self.assertEqual(len(decider.calls), 2)

    def test_only_failed_batch_uses_existing_chat_fallback(self):
        old = [dec(str(i), 'DB', f'DB = {i}') for i in range(4)]
        ranked = conflict.find_candidates(dec('new', 'DB', 'x'), old)
        llm = FakeLLM({'results': [{'id': ranked[-1]['id'], 'judgement': '충돌', 'reason': '시험 응답', 'confidence': .9}]})
        result = conflict.handle_request({'newCards': [dec('new', 'DB', 'x')], 'existing': old},
                                         llm, decider=RecordingDecider(fail_at=2, transport_failure=True), allow_rules=False)
        self.assertTrue(result['ok'], result)
        self.assertEqual(len(llm.prompts), 1)
        self.assertEqual([j['method'] for j in result['results'][0]['judgements']],
                         ['decisions', 'decisions', 'decisions', 'chat'])
        self.assertEqual(len(result['conflicts']), 1)

    def test_limits_fail_before_any_model_call(self):
        for old in ([dec(str(i), 'DB', 'x') for i in range(config.CONFLICT_MAX_CANDIDATES + 1)],
                    [dec('old', 'DB', 'x' * config.CONFLICT_MAX_INPUT_CHARS)]):
            decider = RecordingDecider()
            result = conflict.handle_request({'newCards': [dec('new', 'DB', 'x')], 'existing': old},
                                             None, decider=decider, allow_rules=False)
            self.assertEqual((result['ok'], result['checkStatus']), (False, 'failed'))
            self.assertFalse(decider.calls)

    def test_time_limit_blocks_fallback_and_rejects_late_result(self):
        for fail_at in (None, 1):
            decider = RecordingDecider(fail_at=fail_at)
            llm = FakeLLM({'results': []})
            with patch.object(conflict.time, 'monotonic', side_effect=[0, 0, config.CONFLICT_CHECK_SECONDS + 1]):
                result = conflict.handle_request({'newCards': [dec('new', 'DB', 'x')],
                                                  'existing': [dec('old', 'DB', 'y')]},
                                                 llm, decider=decider, allow_rules=False)
            self.assertEqual((result['ok'], result['checkStatus']), (False, 'failed'))
            self.assertEqual(len(decider.calls), 1)
            self.assertFalse(llm.prompts)

    def test_maximum_pool_is_fully_compared(self):
        old = [dec(str(i), f'topic-{i}', f'value-{i}') for i in range(config.CONFLICT_MAX_CANDIDATES)]
        decider = RecordingDecider()
        result = conflict.handle_request({'newCards': [dec('new', 'different', 'new value')], 'existing': old},
                                         None, decider=decider, allow_rules=False)
        self.assertEqual(result['checkStatus'], 'complete')
        self.assertEqual(len(result['results'][0]['judgements']), len(old))
        self.assertTrue(all(len(qs) <= config.CONFLICT_TOP_K for _, qs in decider.calls))


class PairwiseDefaultTest(unittest.TestCase):
    def test_search_labels_are_not_sent_as_decision_evidence(self):
        old = {**dec('old', 'SEARCH_LABEL_ONLY', '상담비 = 3000원'), 'reason': '참가비와는 다른 항목'}
        new = dec('new', 'SEARCH_LABEL_ONLY', '참가비 = 0원')
        client = RecordingDecider()
        conflict.check_new_decision(new, [old], decider=client, allow_rules=False)
        text = client.calls[0][0]
        self.assertNotIn('SEARCH_LABEL_ONLY', text)
        self.assertIn('상담비 = 3000원', text)
        self.assertIn('참가비와는 다른 항목', text)
        chat = FakeLLM({'results': [dict(id='old', judgement='무관', confidence=.9)]})
        conflict.ai_judge(new, [old], chat, allow_rules=False)
        self.assertNotIn('SEARCH_LABEL_ONLY', str(chat.prompts))

    def test_default_checks_every_candidate_in_its_own_request(self):
        old = [dec(str(i), f'topic-{i}', f'value-{i}') for i in range(30)]
        client = RecordingDecider()
        result = conflict.handle_request({'newCards': [dec('new', 'new-topic', 'new-value')],
                                          'existing': old}, None, decider=client, allow_rules=False)
        self.assertEqual(result['checkStatus'], 'complete')
        self.assertEqual(len(client.calls), 30)
        self.assertEqual({j['id'] for j in result['results'][0]['judgements']}, {c['id'] for c in old})
        for text, questions in client.calls:
            self.assertEqual(len(questions), 1)
            self.assertNotIn('e2:', text)


if __name__ == '__main__':
    unittest.main()
