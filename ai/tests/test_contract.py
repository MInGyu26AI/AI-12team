"""Trust-boundary regressions for the integrated collector/server contract."""
import unittest

from syncup_ai.classify import handle_request
from syncup_ai.conflict import handle_request as conflicts, find_candidates
from tests.test_ai import FakeLLM, msg, dec


class ContractTest(unittest.TestCase):
    def card(self, sentence):
        return dict(msg=1, relevance='related', sentence=sentence, content='DB = SQLite',
                    tag='decision', subtopic='작업·결과물', topic_key='DB', confidence=.95)

    def test_fabricated_evidence_fails_without_losing_source(self):
        request = dict(messages=[msg(1, 'DB 차이를 설명해 줘.')])
        result = handle_request(request, FakeLLM({'cards': [self.card('SQLite로 결정했다.')]}))
        self.assertFalse(result['ok'])
        self.assertEqual(request['messages'][0]['text'], 'DB 차이를 설명해 줘.')

    def test_guessed_role_and_source_are_preserved_for_review(self):
        sentence = 'SQLite로 결정했다.'
        request = dict(messages=[{**msg(1, sentence), 'roleGuessed': True}])
        result = handle_request(request, FakeLLM({'cards': [self.card(sentence)]}))
        self.assertTrue(result['ok'])
        card = result['cards'][0]
        self.assertEqual(card['evidence'], dict(messageId='m1', role='user', roleGuessed=True, quote=sentence))
        self.assertLess(card['confidence'], .6)
        self.assertEqual(card['classificationMethod'], 'chat')

    def test_real_conflict_check_fails_closed_but_explicit_demo_is_labeled(self):
        class Down:
            def chat_json(self, *args): raise RuntimeError('offline')
            def decide(self, *args): raise RuntimeError('offline')
        request = dict(existing=[dec('a', 'DB', 'PostgreSQL')], newCards=[dec('b', 'DB', 'SQLite')])
        real = conflicts(request, Down(), decider=Down(), allow_rules=False)
        self.assertEqual((real['ok'], real['checkStatus']), (False, 'failed'))
        demo = conflicts(request, None, allow_rules=True)
        self.assertEqual(demo['checkStatus'], 'degraded')
        self.assertEqual(demo['conflicts'][0]['method'], 'rule')

    def test_candidates_exclude_inactive_but_keep_other_topics_without_top_three_loss(self):
        old = [dec(str(i), 'DB', str(i)) for i in range(4)]
        old += [{**dec('inactive', 'DB', 'x'), 'decisionState': 'superseded'},
                {**dec('dismissed', 'DB', 'y'), 'status': 'dismissed'}, dec('other', 'DB 색', 'SQLite')]
        candidates = find_candidates(dec('new', 'db', 'SQLite'), old)
        self.assertEqual(len(candidates), 5)
        self.assertEqual(candidates[-1]['id'], 'other')


if __name__ == '__main__':
    unittest.main()
