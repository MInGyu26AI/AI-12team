"""환경 변수로 고르는 AI 클라이언트와 Responses 응답 해석 (외부 요청 없음)."""
import os
import unittest
from unittest.mock import patch

from syncup_ai import llm
from syncup_ai.llm import LLMError, LLMNotConfigured, OpenAICompatible, OpenAIResponses

CLEAN = {k: v for k, v in os.environ.items() if not k.startswith(("AI_", "OPENAI_"))}


def env(**values):
    return patch.dict(os.environ, {**CLEAN, **values}, clear=True)


class ClientSelectionTest(unittest.TestCase):
    def test_openai_key_alone_selects_responses_and_decisions(self):
        with env(OPENAI_API_KEY="synthetic-key", AI_MODEL=" "):  # 공백만 있는 값은 빈 값이다
            chat, decider = llm.from_env(), llm.decider_from_env()
        self.assertIsInstance(chat, OpenAIResponses)
        self.assertEqual(chat.model, llm.DEFAULT_CHAT_MODEL)
        self.assertEqual((decider.base_url, decider.model), (llm.OPENAI_API, llm.DEFAULT_DECISIONS_MODEL))

    def test_any_provider_value_turns_the_default_path_off_for_both(self):
        with env(OPENAI_API_KEY="synthetic-key", AI_BASE_URL="https://example.invalid/v1"):
            self.assertRaises(LLMNotConfigured, llm.from_env)
            self.assertIsNone(llm.decider_from_env())

    def test_custom_provider_needs_all_three_values(self):
        with env(AI_BASE_URL="https://example.invalid/v1", AI_API_KEY="k", AI_MODEL="m", AI_DECISIONS_MODEL="d"):
            chat, decider = llm.from_env(), llm.decider_from_env()
        self.assertIsInstance(chat, OpenAICompatible)
        self.assertEqual((decider.base_url, decider.model), ("https://example.invalid/v1", "d"))


class ResponsesShapeTest(unittest.TestCase):
    def reply(self, response):
        with patch("syncup_ai.llm._post", return_value=response):
            return OpenAIResponses("synthetic-key").chat_json("system", "user")

    def test_output_text_parts_are_joined(self):
        response = {"output": [{"type": "reasoning"},
                               {"content": [{"type": "output_text", "text": '{"cards": '}, {"type": "output_text", "text": "[]}"}]}]}
        self.assertEqual(self.reply(response), {"cards": []})

    def test_unexpected_shape_is_an_llm_error(self):
        for response in ({}, {"output": None}, {"output": ["text"]}, {"output": [{"content": [{"text": "x"}]}]}, []):
            with self.subTest(response=response), self.assertRaises(LLMError):
                self.reply(response)


if __name__ == "__main__":
    unittest.main()
