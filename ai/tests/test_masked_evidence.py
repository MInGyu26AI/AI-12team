import json
import unittest
from unittest.mock import patch

from syncup_ai.classify import handle_request
from syncup_ai.evidence import render_evidence
from tests.fakes import FakeLLM, msg


class MaskedEvidenceTest(unittest.TestCase):
    original = '서울시 가상로 123에서 회의하자.'
    sentence = '[주소]에서 회의하자.'

    def run_card(self, **changes):
        raw = dict(msg=1, relevance='related', sentence=self.sentence,
                   source_sentence=self.original, redactions=[dict(text='서울시 가상로 123', token='[주소]')],
                   content='회의 진행', tag='decision', subtopic='역할·일정', topic_key='회의', confidence=.9)
        raw.update(changes)
        return handle_request(dict(messages=[msg(1, self.original)]), FakeLLM(dict(cards=[raw])))

    def test_redaction_preserves_source_and_never_returns_unmasked_quote(self):
        result = self.run_card()
        self.assertTrue(result['ok'], result)
        card = result['cards'][0]
        self.assertTrue(card['masked'])
        self.assertEqual(render_evidence(self.original, card['evidence']), self.sentence)
        self.assertNotIn('서울시', json.dumps(card, ensure_ascii=False))

    def test_fabrication_or_unexplained_mask_is_rejected(self):
        for change in (dict(source_sentence='부산시 가상로 123에서 회의하자.'),
                       dict(redactions=[]), dict(redactions=[dict(text='없는 주소', token='[주소]')]),
                       dict(sentence='[주소]에서 배포하자.'),
                       dict(redactions=[dict(text='서울시 가상로 123', token='[임의표시]')])):
            with self.subTest(change=change):
                self.assertFalse(self.run_card(**change)['ok'])

    def test_metadata_is_masked_too(self):
        key = 'sk-proj-SyntheticOnly0123456789'
        result = self.run_card(owner=key, topic_key=key, reason=key)
        self.assertTrue(result['ok'], result)
        self.assertNotIn(key, json.dumps(result))

    def test_quote_outside_transmitted_limit_is_rejected(self):
        with patch('syncup_ai.config.MAX_USER_CHARS', 2):
            self.assertFalse(self.run_card()['ok'])

    def test_invalid_stored_offsets_fail_closed(self):
        for evidence in (dict(sourceStart=-1, sourceEnd=2),
                         dict(sourceStart=0, sourceEnd=1000),
                         dict(sourceStart=0, sourceEnd=2, redactions=[dict(start=0,end=3,token='[주소]')])):
            with self.subTest(evidence=evidence), self.assertRaises(ValueError):
                render_evidence(self.original, evidence)
