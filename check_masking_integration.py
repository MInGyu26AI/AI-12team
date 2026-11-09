"""Synthetic SQLite input -> masked evidence -> edit -> approved payload checks."""
import json
import unittest
import check_pipeline  # module import: PipelineTest is not collected (and run again) here
from storage import connect


class MaskingIntegration(unittest.TestCase):
    setUp = check_pipeline.PipelineTest.setUp
    message = check_pipeline.PipelineTest.message

    def test_semantic_mask_survives_review_and_approval_without_raw_quote(self):
        original = '서울시 가상로 123에서 회의하자.'
        def reply(system, user):
            return dict(cards=[dict(msg=1, relevance='related', tag='decision', subtopic='역할·일정',
                topic_key='회의', content='회의 진행', owner='테스트', confidence=.9,
                sentence='[주소]에서 회의하자.', source_sentence=original,
                redactions=[dict(text='서울시 가상로 123', token='[주소]')])])
        self.ai.chat_json = reply
        self.pipeline.append([dict(self.message(), text=original)], True)
        self.pipeline.process()
        card = self.pipeline.candidates()[0]
        self.pipeline.update(card['id'], dict(content='회의 준비'))
        with self.assertRaises(ValueError):
            self.pipeline.update(card['id'], dict(sentence='[주소]에서 배포하자.'))
        self.pipeline.rpc('candidates.approve', dict(ids=[card['id']], teamId='a'))
        with connect(self.db) as c:
            payload = c.execute('SELECT payload FROM outbox').fetchone()[0]
            self.assertNotIn('서울시', payload)
            self.assertNotIn('source_sentence', payload)
            self.assertNotIn('redactions', payload)
            self.assertEqual(json.loads(payload)['card']['sentence'], '[주소]에서 회의하자.')

    def test_all_supported_sources_mask_before_queue_and_model(self):
        secret = 'sk-proj-SyntheticOnly0123456789'
        for index, site in enumerate(('manual', 'chatgpt', 'chatgpt-export')):
            self.pipeline.append([dict(self.message(str(index)), site=site,
                text='SQLite로 결정했다. 키 '+secret)], True)
        self.pipeline.process()
        self.assertEqual(len(self.ai.calls), 3)
        self.assertNotIn(secret, ''.join(self.ai.calls))
        with connect(self.db) as c:
            for table, column in (('intake','message'), ('job_context','messages'), ('jobs','evidence')):
                for row in c.execute(f'SELECT {column} FROM {table}'):
                    self.assertNotIn(secret, row[0])
        card = self.pipeline.candidates()[0]
        self.pipeline.update(card['id'], dict(content='키 '+secret))
        self.pipeline.rpc('candidates.approve', dict(ids=[card['id']], teamId='a'))
        with connect(self.db) as c:
            payload = c.execute('SELECT payload FROM outbox').fetchone()[0]
            self.assertNotIn(secret, payload)
            self.assertTrue(json.loads(payload)['card']['masked'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
