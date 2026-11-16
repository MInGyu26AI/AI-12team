"""Pre-approval alert (미리 알림): the team's current decisions reach the classifier, and a candidate that changes one
of them on the same topic is flagged for its owner only (collector/team_decisions.py)."""
import repo_paths  # noqa: F401
from datetime import datetime, timezone
import http.client
import json
import re
import unittest

from batch_classification import classify_queued
from candidate_review import list_candidates, update_candidate
from collection_status import collection_status
from local_fixtures import AI, PipelineFixture
from local_rpc import dispatch
from storage import connect
import team_decisions
import turn_intake

TEAM_DECISION = dict(id='t1', tag='decision', topic_key='확장 지원', content='확장 지원 = 크롬 우선', decisionState='active')
TEAM_TODO = dict(id='t2', tag='todo', topic_key='확장 지원', content='크롬 스토어 등록', decisionState='active')
# The user prompt line of message [1]: "[1] 사용자 (2026-11-14 23:30): text"
FIRST_MESSAGE = re.compile(r'^\[1\] .*?\(\d{4}-\d\d-\d\d \d\d:\d\d\): (.+)$', re.M)


class ChangeAI(AI):
    """Classifier stand-in: one decision quoting message [1], with the topic, content and is_change a test sets."""
    def __init__(self, topic='확장 지원', content='확장 지원 = 파이어폭스 우선', is_change=True):
        super().__init__()
        self.card = dict(topic_key=topic, content=content, is_change=is_change)

    def chat_json(self, system, user):
        self.before_request()
        self.calls.append(user)
        sentence = FIRST_MESSAGE.search(user).group(1)
        return dict(cards=[dict(msg=1, relevance='related', tag='decision', subtopic='작업·결과물', sentence=sentence,
                                confidence=.9, owner='테스트', **self.card)])


class PreAlertFixture(PipelineFixture):
    def setUp(self):
        super().setUp()
        self.ai = ChangeAI()
        self.pipeline.llm_factory = lambda: self.ai
        self.board = [TEAM_DECISION, TEAM_TODO]
        self.board_reads = 0
        original = self.pipeline.client.request

        def request(path, data=None):
            if path == 'teams/a/board' and data is None:
                self.board_reads += 1
                return dict(team_id='a', items=None if self.board is None else list(self.board))
            return original(path, data)
        self.pipeline.client.request = request

    def collect(self, text='확장은 파이어폭스 먼저 지원하자.', conversation='conv', identifier='one'):
        message = dict(id=identifier, site='manual', conversationId=conversation, role='user', roleGuessed=False,
                       text=text, collectedAt=datetime.now(timezone.utc).isoformat())
        turn_intake.append(self.pipeline, [message], True)
        classify_queued(self.pipeline)
        return list_candidates(self.pipeline)

    def prompt(self):
        return self.ai.calls[-1]


class ClassifierInput(PreAlertFixture):
    def test_current_team_decisions_and_their_topics_go_into_the_prompt(self):
        self.collect()
        self.assertIn('- 기존 팀 결정:\n  - [확장 지원] 확장 지원 = 크롬 우선', self.prompt())
        self.assertIn('- 기존 세부 주제: 확장 지원', self.prompt())
        self.assertNotIn('크롬 스토어 등록', self.prompt())  # a to-do is not a decision

    def test_an_unreachable_team_server_sends_an_empty_list_as_before(self):
        def offline(path, data=None):
            raise OSError('팀 서버 없음')
        self.pipeline.client.request = offline
        cards = self.collect()
        self.assertIn('- 기존 팀 결정:\n  (없음)', self.prompt())
        self.assertEqual(len(cards), 1)
        self.assertIsNone(cards[0]['preAlert'])

    def test_a_cut_off_team_answer_sends_an_empty_list_and_the_batch_still_runs(self):
        def cut_off(path, data=None):
            raise http.client.IncompleteRead(b'{"team_id"')  # not an OSError
        self.pipeline.client.request = cut_off
        cards = self.collect()
        self.assertIn('- 기존 팀 결정:\n  (없음)', self.prompt())
        self.assertEqual(len(cards), 1)

    def test_an_older_team_server_without_a_board_answer_sends_an_empty_list(self):
        self.board = None  # answers {'team_id': 'a', 'items': None}
        self.collect()
        self.assertIn('- 기존 팀 결정:\n  (없음)', self.prompt())

    def test_at_most_thirty_decisions_the_latest_first(self):
        self.board = [dict(TEAM_DECISION, id=f'd{n}', topic_key=f'주제{n}', content=f'주제{n} = 값{n}') for n in range(35)]
        self.collect()
        lines = re.findall(r'^  - \[(주제\d+)\]', self.prompt(), re.M)
        self.assertEqual(lines, [f'주제{n}' for n in range(34, 4, -1)])

    def test_a_decision_carrying_a_secret_is_left_out_and_the_batch_still_runs(self):
        self.board = [dict(TEAM_DECISION, id='s', topic_key='서버 키', content='서버 키 = sk-proj-ABCDEFGHIJKLMNOPQRSTUV'),
                      TEAM_DECISION]
        cards = self.collect()
        self.assertNotIn('서버 키', self.prompt())
        self.assertIn('[확장 지원] 확장 지원 = 크롬 우선', self.prompt())
        self.assertEqual(len(cards), 1)

    def test_the_board_is_read_once_per_classification_run(self):
        for n in range(3):
            turn_intake.append(self.pipeline, [dict(id=f'm{n}', site='manual', conversationId=f'c{n}', role='user',
                                                    roleGuessed=False, text=f'확장은 파이어폭스 먼저 지원하자 {n}.',
                                                    collectedAt=datetime.now(timezone.utc).isoformat())], True)
        classify_queued(self.pipeline)
        self.assertEqual(len(self.ai.calls), 3)
        self.assertEqual(self.board_reads, 1)


class Alert(PreAlertFixture):
    def test_a_change_on_a_team_topic_is_flagged_with_the_team_decision(self):
        [card] = self.collect()
        alert = card['preAlert']
        self.assertEqual(alert['topicKey'], '확장 지원')
        self.assertEqual(alert['decisions'], [dict(id='t1', topic_key='확장 지원', content='확장 지원 = 크롬 우선')])
        self.assertNotIn(team_decisions.STORED_KEY, card)
        [summary] = collection_status(self.pipeline)['preAlerts']
        self.assertEqual(summary, dict(alert, candidates=1))
        self.assertNotIn('파이어폭스', json.dumps(summary, ensure_ascii=False))  # the candidate's own words stay out

    def test_no_alert_without_is_change(self):
        self.ai.card['is_change'] = False
        self.assertIsNone(self.collect()[0]['preAlert'])
        self.assertEqual(collection_status(self.pipeline)['preAlerts'], [])

    def test_no_alert_on_another_topic(self):
        self.ai.card['topic_key'] = '브라우저 종류'
        self.assertIsNone(self.collect()[0]['preAlert'])

    def test_topic_and_content_are_compared_normalized(self):
        self.board = [dict(TEAM_DECISION, topic_key='MVP 범위', content='브라우저 확장 = MVP 포함')]
        self.ai.card.update(topic_key='mvp범위', content='브라우저 확장=MVP 포함')
        self.assertIsNone(self.collect()[0]['preAlert'])  # same topic, same content: nothing changes
        self.ai.card['content'] = '브라우저 확장 = 행사 이후'
        cards = self.collect(text='브라우저 확장은 행사 이후로 미루자.', identifier='two', conversation='c2')
        self.assertEqual(cards[1]['preAlert']['topicKey'], 'MVP 범위')

    def test_the_same_decision_from_two_conversations_is_one_alert(self):
        first = self.collect()
        both = self.collect(text='확장은 파이어폭스부터 지원하자.', conversation='other', identifier='two')
        self.assertEqual(len(both), 2)
        self.assertEqual(both[0]['preAlert']['key'], both[1]['preAlert']['key'])
        self.assertEqual(first[0]['preAlert']['key'], both[0]['preAlert']['key'])
        [summary] = collection_status(self.pipeline)['preAlerts']
        self.assertEqual(summary['candidates'], 2)

    def test_editing_the_topic_or_content_clears_the_alert(self):
        [card] = self.collect()
        update_candidate(self.pipeline, card['id'], dict(content='확장 지원 = 크롬 우선'))
        self.assertIsNone(list_candidates(self.pipeline)[0]['preAlert'])
        update_candidate(self.pipeline, card['id'], dict(content='확장 지원 = 파이어폭스 우선'))
        self.assertIsNotNone(list_candidates(self.pipeline)[0]['preAlert'])
        update_candidate(self.pipeline, card['id'], dict(topic_key='브라우저 종류'))
        self.assertIsNone(list_candidates(self.pipeline)[0]['preAlert'])

    def test_rewording_in_review_keeps_the_key_so_it_is_not_announced_again(self):
        [card] = self.collect()
        update_candidate(self.pipeline, card['id'], dict(content='확장 지원 = 파이어폭스 먼저'))
        self.assertEqual(list_candidates(self.pipeline)[0]['preAlert']['key'], card['preAlert']['key'])

    def test_nothing_of_the_alert_reaches_the_team(self):
        [card] = self.collect()
        dispatch(self.pipeline, 'candidates.approve', dict(ids=[card['id']], teamId='a'))
        with connect(self.db) as c:
            payload = c.execute('SELECT payload FROM outbox').fetchone()[0]
        self.assertNotIn('preAlert', payload)
        self.assertNotIn('크롬 우선', payload)
        self.assertNotIn('t1', json.loads(payload)['card'].values())
        self.assertIsNone(list_candidates(self.pipeline)[0]['preAlert'])  # approved: no longer a pre-approval alert
        self.assertEqual(collection_status(self.pipeline)['preAlerts'], [])


class Matching(unittest.TestCase):
    def test_normalized_ignores_case_spaces_punctuation_and_width(self):
        self.assertEqual(team_decisions.normalized(' MVP 범위! '), team_decisions.normalized('ｍｖｐ범위'))
        self.assertNotEqual(team_decisions.normalized('MVP 범위'), team_decisions.normalized('MVP 일정'))

    def test_only_a_decision_marked_as_a_change_is_compared(self):
        decisions = [dict(id='t1', topic_key='타깃', content='타깃 = 대학생')]
        card = dict(tag='decision', is_change=True, topic_key='타깃', content='타깃 = 직장인')
        self.assertEqual(team_decisions.changed_decisions(card, decisions), decisions)
        self.assertEqual(team_decisions.changed_decisions(dict(card, tag='todo'), decisions), [])
        self.assertEqual(team_decisions.changed_decisions(dict(card, is_change=False), decisions), [])
        self.assertEqual(team_decisions.changed_decisions(dict(card, topic_key=None), decisions), [])

    def test_stored_alert_keeps_the_key_and_pre_alert_checks_the_card_as_it_is_now(self):
        decisions = [dict(id='t1', topic_key='타깃', content='타깃 = 대학생')]
        card = dict(tag='decision', is_change=True, topic_key='타깃', content='타깃 = 직장인')
        stored = team_decisions.stored_alert(card, decisions)
        self.assertEqual(stored['decisions'], decisions)
        self.assertIsNone(team_decisions.stored_alert(dict(card, content='타깃=대학생'), decisions))
        self.assertEqual(team_decisions.pre_alert(dict(card, content='타깃 = 고등학생'), stored)['key'], stored['key'])
        self.assertIsNone(team_decisions.pre_alert(dict(card, content='타깃 = 대학생'), stored))
        self.assertIsNone(team_decisions.pre_alert(card, None))

    def test_summaries_count_candidates_per_key(self):
        a, b = dict(key='x', topicKey='타깃', decisions=[]), dict(key='y', topicKey='DB', decisions=[])
        self.assertEqual([(s['key'], s['candidates']) for s in team_decisions.summaries([a, b, a])], [('x', 2), ('y', 1)])


if __name__ == '__main__':
    unittest.main()
