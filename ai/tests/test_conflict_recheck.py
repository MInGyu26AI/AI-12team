"""Low confidence stops once; only transient transport failures permit automatic retry."""
import unittest
from unittest.mock import Mock, patch

from syncup_ai import config, conflict
from syncup_ai.decide import judge_pairs
from syncup_ai.llm import RetryableLLMError, LLMError
from tests.test_ai import dec


class RecheckTest(unittest.TestCase):
    def setUp(self):
        self.new = dec('new', 'UI', '고객 화면 = Vue')
        self.old = [dec('old', 'UI', '고객 화면 = React')]

    def run_check(self, answers, **kwargs):
        client = Mock()
        client.decide.side_effect = answers
        result = conflict.handle_request({'newCards': [self.new], 'existing': self.old},
                                         kwargs.pop('llm', None), decider=client, **kwargs)
        return result, client

    @patch.object(config, 'CONFLICT_TOP_K', 3)
    def test_uncertain_batch_stops_without_partial_success_or_more_calls(self):
        self.old += [dec('two', 'UI', '아이콘 = 원형'), dec('three', 'UI', '폰트 = 고딕')]
        first = {f'e{i}': dict(choice=j, confidence=c) for i, (j, c) in
                 enumerate([('같음', .2), ('무관', .59), ('무관', .9)], 1)}
        result, client = self.run_check([first], allow_rules=False)
        self.assertEqual(result['checkStatus'], 'failed')
        self.assertEqual(result['failureReason'], 'low-confidence')
        self.assertFalse(result['retryable'])
        self.assertEqual([len(c.args[1]) for c in client.decide.call_args_list], [3])
        self.assertNotIn('conflicts', result)

    def test_uncertain_any_label_blocks_chat_rules_and_partial_success(self):
        for label in conflict.JUDGEMENTS:
            for confidence in (0, .5999, None, float('nan'), 1.1, True):
                with self.subTest(label=label, confidence=confidence):
                    chat = Mock()
                    result, client = self.run_check([
                        {'e1': dict(choice=label, confidence=confidence)}], llm=chat, allow_rules=True)
                    self.assertEqual((result['ok'], result['checkStatus']), (False, 'failed'))
                    self.assertNotIn('results', result)
                    self.assertNotIn('conflicts', result)
                    self.assertEqual(client.decide.call_count, 1)
                    self.assertFalse(result['retryable'])
                    chat.chat_json.assert_not_called()

    def test_missing_or_permanent_error_is_not_provider_fallback(self):
        for retry in ({}, RuntimeError('synthetic outage')):
            chat = Mock()
            result, client = self.run_check([retry],
                                      llm=chat, allow_rules=True)
            self.assertEqual(result['checkStatus'], 'failed')
            self.assertFalse(result['retryable'])
            self.assertEqual(client.decide.call_count, 1)
            chat.chat_json.assert_not_called()

    def test_missing_zero_and_unrounded_confidence_stop_once(self):
        for value in (None, 0, .5999):
            first = {'e1': dict(choice='같음', confidence=value)}
            result, client = self.run_check([first], allow_rules=False)
            self.assertEqual(result['checkStatus'], 'failed')
            self.assertEqual(client.decide.call_count, 1)
        client = Mock(); client.decide.return_value = {'e1': dict(choice='같음', confidence=0)}
        self.assertEqual(judge_pairs(self.new, self.old, client)[0]['confidence'], 0)

    def test_confident_results_do_not_add_calls(self):
        for label, confidence in [('같음', .6), ('무관', .9), ('충돌', .6), ('변경', .9)]:
            result, client = self.run_check([{'e1': dict(choice=label, confidence=confidence)}], allow_rules=False)
            self.assertEqual(result['checkStatus'], 'complete')
            self.assertEqual(client.decide.call_count, 1)

    def test_low_confidence_alerts_cannot_bypass_review(self):
        for label in ('충돌', '변경'):
            result, client = self.run_check([{'e1': dict(choice=label, confidence=.12)}], allow_rules=False)
            self.assertEqual(client.decide.call_count, 1)
            self.assertEqual(result['failureReason'], 'low-confidence')
            self.assertFalse(result['retryable'])
            self.assertNotIn('conflicts', result)

    def test_deadline_before_or_after_request_fails(self):
        for ticks, expected in [([0, 91], 0), ([0, 0, 91], 1)]:
            with patch.object(conflict.time, 'monotonic', side_effect=ticks):
                result, client = self.run_check([{'e1': dict(choice='충돌', confidence=.9)}], allow_rules=False)
            self.assertEqual(result['checkStatus'], 'failed')
            self.assertEqual(client.decide.call_count, expected)
            self.assertFalse(result['retryable'])

    def test_transport_fallback_also_stops_on_low_or_missing_confidence(self):
        for confidence, expected in [(.9, 'complete'), (None, 'failed')]:
            chat = Mock()
            chat.chat_json.side_effect = [{'results': [dict(id='old', judgement='충돌', confidence=confidence)]}]
            result, _ = self.run_check([RetryableLLMError('synthetic outage')], llm=chat, allow_rules=False)
            self.assertEqual(result['checkStatus'], expected)
            self.assertEqual(chat.chat_json.call_count, 1)

    def test_only_transport_failure_is_retryable(self):
        for error, retryable in [(RetryableLLMError('offline'), True), (LLMError('unauthorized'), False),
                                 (ValueError('invalid'), False)]:
            result, client = self.run_check([error], allow_rules=False)
            self.assertEqual(result['retryable'], retryable)
            self.assertEqual(client.decide.call_count, 1)

    def test_nontransient_chat_fallback_failure_stops_server_retries(self):
        chat = Mock(); chat.chat_json.side_effect = LLMError('unauthorized')
        result, _ = self.run_check([RetryableLLMError('offline')], llm=chat, allow_rules=False)
        self.assertFalse(result['retryable'])
        self.assertEqual(chat.chat_json.call_count, 1)


if __name__ == '__main__':
    unittest.main()
