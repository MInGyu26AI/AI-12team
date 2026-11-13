"""Trust-boundary regressions for the integrated collector/server contract."""
import unittest

from syncup_ai.classify import handle_request
from syncup_ai.conflict import handle_request as conflicts, find_candidates
from tests.fakes import FakeLLM, msg, dec


class ContractTest(unittest.TestCase):
    def card(self, sentence):
        return dict(msg=1, relevance='related', sentence=sentence, content='DB = SQLite',
                    tag='decision', subtopic='작업·결과물', topic_key='DB', confidence=.95)

    def test_fabricated_evidence_fails_without_losing_source(self):
        request = dict(messages=[msg(1, 'DB 차이를 설명해 줘.')])
        result = handle_request(request, FakeLLM({'cards': [self.card('SQLite로 결정했다.')]}))
        self.assertFalse(result['ok'])
        self.assertEqual(request['messages'][0]['text'], 'DB 차이를 설명해 줘.')

    def test_discarded_card_with_bad_evidence_does_not_fail_the_batch(self):
        # 저장하지 않을 제안 카드나 AI 답변의 상한 초과 카드는 근거가 틀려도 같은 묶음의 결정을 막지 않는다 (코드 지도 지적)
        request = dict(messages=[msg(1, 'SQLite로 결정했다.'), msg(2, 'MySQL도 괜찮아요.', role='assistant')])
        suggestion = dict(msg=2, relevance='related', sentence='MySQL을 추천합니다.', content='MySQL 추천',
                          tag='none', subtopic='작업·결과물', topic_key='DB', confidence=.9)
        result = handle_request(request, FakeLLM({'cards': [self.card('SQLite로 결정했다.'), suggestion]}))
        self.assertTrue(result['ok'])
        self.assertEqual([c['tag'] for c in result['cards']], ['decision'])

    def test_guessed_assistant_decision_is_kept_for_review(self):
        # 화자를 AI 로 잘못 추정한 사용자 결정이 검토 전에 사라지지 않는다. 확인 필요로 남고 화자 확인을 기다린다 (코드 지도 지적)
        sentence = '응 확장은 빼자.'
        request = dict(messages=[{**msg(1, sentence, role='assistant'), 'roleGuessed': True}])
        llm = FakeLLM({'cards': [self.card(sentence)]})
        result = handle_request(request, llm)
        card = result['cards'][0]
        self.assertEqual((card['tag'], card['evidence']['roleGuessed']), ('decision', True))
        self.assertLess(card['confidence'], .6)
        self.assertIn('화자 미상', llm.prompts[0])
        # 화자를 읽은 AI 발화는 전처럼 제안으로 낮춘다
        plain = handle_request(dict(messages=[msg(1, sentence, role='assistant')]), FakeLLM({'cards': [self.card(sentence)]}))
        self.assertEqual(plain['cards'][0]['tag'], 'none')

    def test_long_sentence_is_cut_to_the_collector_limit(self):
        # 사용자 발화는 2000자까지 보내는데 수집기는 카드 칸을 1200자까지만 받는다 (코드 지도 지적)
        text = 'DB는 SQLite로 하자. ' + '가' * 1500
        result = handle_request(dict(messages=[msg(1, text)]), FakeLLM({'cards': [{**self.card(text), 'content': None}]}))
        self.assertTrue(result['ok'])
        card = result['cards'][0]
        self.assertEqual((len(card['sentence']), len(card['content'])), (1200, 1200))
        self.assertTrue(text.startswith(card['evidence']['quote']))

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
