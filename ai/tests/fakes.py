"""시험용 가짜 AI 클라이언트와 카드·발화 만들기 (외부 호출 없음)."""
from syncup_ai.llm import parse_json_reply


class FakeLLM:
    """정해진 JSON 을 돌려주는 chat 모델. 받은 사용자 프롬프트를 prompts 에 남긴다."""

    def __init__(self, reply):
        self.reply, self.prompts = reply, []

    def chat_json(self, system, user):
        self.prompts.append(user)
        return self.reply if isinstance(self.reply, dict) else parse_json_reply(self.reply)


def default_answer(question):
    """DecisionsClient 가 검증을 통과시키는 모양의 기본 답 (첫 선택지, 확신도 0.9 / 확률 0)."""
    if question["type"] == "predicate":
        return {"type": "predicate", "name": question["name"], "probability": 0.0}
    return {"type": "choice", "name": question["name"], "choice": question["choices"][0]["value"], "confidence": 0.9}


class FakeDecider:
    """answers(question) 가 준 답을, 빈 값(None·{})이면 기본 답을 돌려준다. 실제 클라이언트처럼 모든 질문에 답한다."""

    def __init__(self, answers=lambda question: None):
        self.answers, self.calls = answers, []

    def decide(self, text, questions):
        self.calls.append((text, questions))
        return {q["name"]: self.answers(q) or default_answer(q) for q in questions}


def msg(i, text, role="user", conv="c1"):
    return {"id": f"m{i}", "site": "chatgpt", "role": role, "text": text, "conversationId": conv,
            "conversationTitle": "t", "url": "", "collectedAt": "2026-11-06T12:10:00Z"}


def dec(id_, topic, content, is_change=False):
    return {"id": id_, "relevance": "related", "tag": "decision", "topic_key": topic, "content": content,
            "sentence": content, "is_change": is_change}


CTX = {"teamName": "싱크업", "projectTopic": "팀 AI 메모리", "userName": "김단비",
       "knownNames": ["김동균", "이서준"], "enabledSubtopics": None, "existingTopicKeys": ["MVP 범위", "서비스명"]}
