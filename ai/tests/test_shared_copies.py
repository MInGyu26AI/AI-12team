"""Python 정의와 그 사본(shared/*.ts, 프롬프트)이 같은 값·이름을 쓰는지. 한쪽만 바꾸면 조용히 '기타'·기본값으로 떨어진다."""
import re
import unittest
from pathlib import Path

from syncup_ai import config
from syncup_ai.decide import SUBTOPIC_DESC, TAG_CHOICES
from syncup_ai.mask import MASK_TOKENS
from syncup_ai.schema import SUBTOPICS, TAGS

REPO = Path(__file__).resolve().parents[2]


def read(relative):
    return (REPO / relative).read_text(encoding="utf-8")


def ts_number(relative, name):
    return float(re.search(rf"export const {name} = ([\d.]+);", read(relative)).group(1))


class SharedCopiesTest(unittest.TestCase):
    def test_numbers_match_typescript(self):
        self.assertEqual(ts_number("shared/batch.ts", "TURNS_PER_BATCH"), config.TURNS_PER_BATCH)
        self.assertEqual(ts_number("shared/labels.ts", "LOW_CONFIDENCE"), config.LOW_CONFIDENCE)

    def test_subtopic_and_tag_names_match_everywhere(self):
        self.assertEqual(tuple(SUBTOPIC_DESC), SUBTOPICS)
        self.assertEqual(tuple(TAG_CHOICES), TAGS)
        types = read("shared/types.ts")
        block = re.search(r"export const SUBTOPICS = \[(.*?)\] as const", types, re.S).group(1)
        self.assertEqual(tuple(re.findall(r'"([^"]+)"', block)), SUBTOPICS)
        self.assertEqual(tuple(re.findall(r'"(\w+)"', re.search(r"export type Tag = ([^;]+);", types).group(1))), TAGS)
        for prompt in ("ai/prompts/classify_system.md", "ai/prompts/decisions_criteria.md"):
            text = read(prompt)
            for name in SUBTOPICS:
                self.assertIn(name, text, prompt)

    def test_classify_prompt_lists_every_mask_token(self):
        line = next(l for l in read("ai/prompts/classify_system.md").splitlines() if "가릴 때는 이 표시만 쓴다" in l)
        self.assertEqual(set(re.findall(r"\[[^\]]+\]", line)), set(MASK_TOKENS))


if __name__ == "__main__":
    unittest.main()
