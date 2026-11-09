"""외부 AI 연결부. 분류·충돌 판정 코드는 이 인터페이스만 쓴다.

chat 모델은 OpenAI Responses(OPENAI_API_KEY 기본 경로) 또는 OpenAI 호환 /chat/completions(AI_BASE_URL·AI_API_KEY·AI_MODEL)로,
Decisions 는 /decisions 로 부른다. 일시적인 통신 실패만 RetryableLLMError 로 구분한다.
"""
from __future__ import annotations

import json
import http.client
import math
import os
import re
import ssl
import urllib.error
import urllib.request
from typing import Protocol

OPENAI_API = "https://api.openai.com/v1"
DEFAULT_CHAT_MODEL = "gpt-6.1-terra"  # OPENAI_API_KEY 기본 경로의 Responses 모델
DEFAULT_DECISIONS_MODEL = "gpt-6-luna"
RETRYABLE_STATUS = (408, 429, 500, 502, 503, 504)


class LLMNotConfigured(RuntimeError):
    pass


class LLMError(RuntimeError):
    """code: AI 서버가 돌려준 HTTP 상태 코드(없으면 None). 진단에는 메시지 대신 이 값을 남긴다."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


class RetryableLLMError(LLMError):
    """일시적인 통신 실패만 서버의 제한된 자동 재시도 대상으로 전달한다."""


class DecisionsResponseError(LLMError):
    """거절·잘못된 응답은 통신 재시도나 chat 라벨 대체로 숨기지 않는다."""


class LLM(Protocol):
    def chat_json(self, system: str, user: str) -> dict: ...


def describe_failure(error: Exception) -> str:
    """로그 한 줄용: 예외 종류와 HTTP 상태 코드만 (메시지에는 응답 본문이 들어 있을 수 있다)."""
    code = getattr(error, "code", None)
    return f"{type(error).__name__} HTTP {code}" if type(code) is int else type(error).__name__


def parse_json_reply(text: str) -> dict:
    """모델 답에서 JSON 객체를 꺼낸다 (```json 코드 블록·앞뒤 설명이 붙어도)."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise LLMError(f"JSON 이 아닌 응답: {text[:200]}")
        data = json.loads(text[start : end + 1])
    if isinstance(data, list):  # 배열만 돌려준 분류 응답. 충돌 판정에서는 results 가 없어 답 누락으로 처리된다.
        data = {"cards": data}
    if not isinstance(data, dict):
        raise LLMError("JSON 객체가 아닌 응답")
    return data


def _post(url: str, key: str, body: dict, timeout: float = 60) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        with e:
            detail = e.read().decode("utf-8", "replace")[:300]
        error = RetryableLLMError if e.code in RETRYABLE_STATUS else LLMError
        raise error(f"AI 서버 오류 {e.code}: {detail}", code=e.code) from e
    except urllib.error.URLError as e:
        # 연결 자체가 끊긴 경우만 다시 시도할 만하다. 인증서 오류·잘못된 주소는 다시 보내도 같다.
        transient = isinstance(e.reason, OSError) and not isinstance(e.reason, ssl.SSLError)
        error = RetryableLLMError if transient else LLMError
        raise error(f"AI 서버 연결 실패: {e.reason}") from e
    except (TimeoutError, ConnectionError, http.client.IncompleteRead) as e:
        raise RetryableLLMError("AI 서버 응답이 끊기거나 제한 시간을 넘었습니다.") from e


class OpenAICompatible:
    def __init__(self, base_url: str, api_key: str, model: str, json_mode: bool = True):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.json_mode = json_mode
        self.before_request = None

    def chat_json(self, system: str, user: str) -> dict:
        body: dict = {
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        if self.before_request:
            self.before_request()
        res = _post(f"{self.base_url}/chat/completions", self.api_key, body)
        try:
            content = res["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"예상과 다른 응답 형식: {str(res)[:200]}") from e
        return parse_json_reply(content)


class OpenAIResponses:
    """OPENAI_API_KEY 기본 경로의 chat 모델 (POST /v1/responses)."""

    def __init__(self, key: str, model: str = DEFAULT_CHAT_MODEL):
        self.key = key
        self.model = model
        self.before_request = None

    def chat_json(self, system: str, user: str) -> dict:
        if self.before_request:
            self.before_request()
        body = {
            "model": self.model,
            "store": False,
            "reasoning": {"effort": "low"},
            "instructions": system,
            "input": user,
            "text": {"format": {"type": "json_object"}},
        }
        res = _post(f"{OPENAI_API}/responses", self.key, body)
        try:
            text = "".join(part["text"] for item in res["output"] for part in item.get("content", [])
                           if part["type"] == "output_text")
        except (KeyError, IndexError, TypeError, AttributeError) as e:
            raise LLMError(f"예상과 다른 응답 형식: {str(res)[:200]}") from e
        return parse_json_reply(text)


def _uses_openai_default() -> bool:
    """AI_ 공급자 값이 모두 비어 있고 OPENAI_API_KEY 가 있으면 OpenAI 기본 경로(Responses + Decisions)를 쓴다."""
    custom = any(os.environ.get(k, "").strip() for k in ("AI_BASE_URL", "AI_API_KEY", "AI_MODEL"))
    return not custom and bool(os.environ.get("OPENAI_API_KEY"))


def from_env() -> LLM:
    if _uses_openai_default():
        return OpenAIResponses(os.environ["OPENAI_API_KEY"])
    base, key, model = (os.environ.get(k, "").strip() for k in ("AI_BASE_URL", "AI_API_KEY", "AI_MODEL"))
    if not (base and key and model):
        raise LLMNotConfigured("외부 AI 설정 없음: OPENAI_API_KEY 를 두거나 ai/.env 에 AI_BASE_URL·AI_API_KEY·AI_MODEL 을 함께 채워 주세요")
    return OpenAICompatible(
        base,
        key,
        model,
        json_mode=os.environ.get("AI_JSON_MODE", "true").lower() != "false",
    )


# ── OpenAI Decisions API (POST /v1/decisions) ──
# 자유 텍스트·JSON 스키마는 못 만들고, 질문마다 정형 답과 확률만 돌려준다. 이 프로젝트는 choice / predicate 만 묻는다.
# 그래서 문장 나누기·content·topic_key·담당자·기한은 chat 모델이, 라벨·충돌 판정·확신도는 Decisions 가 맡는다.
# 문서: https://developers.openai.com/api/docs/guides/decisions

def choice_q(name: str, instructions: str, choices: dict[str, str]) -> dict:
    return {"type": "choice", "name": name, "instructions": instructions,
            "choices": [{"value": v, "description": d} for v, d in choices.items()]}


def predicate_q(name: str, instructions: str) -> dict:
    return {"type": "predicate", "name": name, "instructions": instructions}


class Decider(Protocol):
    def decide(self, input_text: str, questions: list[dict]) -> dict[str, dict]: ...


def _decision_number(value, upper: float = 1) -> bool:
    return type(value) in (int, float) and 0 <= value <= upper and math.isfinite(value)


def _choice_index(values: list, value) -> int | None:
    """선택지 위치. True == 1 이지만 다른 값이므로 타입까지 같아야 한다."""
    return next((i for i, v in enumerate(values) if type(value) is type(v) and value == v), None)


def _validate_decision_answers(response: dict, questions: list[dict]) -> dict[str, dict]:
    expected = {q['name']: q for q in questions}
    if not isinstance(response, dict) or not isinstance(response.get('answers'), list):
        raise DecisionsResponseError('Decisions 응답에 answers 배열이 없습니다.')
    out = {}
    for answer in response['answers']:
        if not isinstance(answer, dict) or not isinstance(answer.get('name'), str):
            raise DecisionsResponseError('Decisions 답의 name 형식이 잘못되었습니다.')
        name = answer['name']
        if name not in expected or name in out:
            raise DecisionsResponseError('Decisions 답의 name이 예상 밖이거나 중복되었습니다.')
        _validate_answer(answer, expected[name])
        out[name] = answer
    if out.keys() != expected.keys():
        raise DecisionsResponseError('Decisions 답이 누락되었습니다.')
    return out


def _validate_answer(answer: dict, question: dict) -> None:
    kind = question['type']
    if answer.get('type') == 'refusal':
        raise DecisionsResponseError('확인 필요: Decisions가 질문에 대한 답을 거절했습니다.')
    if answer.get('type') != kind:
        raise DecisionsResponseError('Decisions 답의 type이 질문과 다릅니다.')
    if 'confidence' in answer and not _decision_number(answer['confidence']):
        raise DecisionsResponseError('Decisions confidence는 0~1의 유한수여야 합니다.')
    if kind == 'predicate':
        if not _decision_number(answer.get('probability')):
            raise DecisionsResponseError('Decisions probability는 0~1의 유한수여야 합니다.')
        return
    values = [option['value'] for option in question['choices']]
    selected = _choice_index(values, answer.get('choice'))
    if selected is None:
        raise DecisionsResponseError('Decisions choice가 허용 선택지에 없습니다.')
    # shortcut: confidence·probabilities 중 하나만 있어도 받는다(기존 confidence-only 응답 호환).
    # 제공자 계약을 엄격히 전환할 때 둘 다 필수로 바꾼다.
    if 'confidence' not in answer and 'probabilities' not in answer:
        raise DecisionsResponseError('Decisions 답에 확신도 근거가 없습니다.')
    if 'probabilities' in answer:
        _validate_distribution(answer['probabilities'], values, selected)


def _validate_distribution(probabilities, values: list, selected: int) -> None:
    if not isinstance(probabilities, list) or len(probabilities) != len(values):
        raise DecisionsResponseError('Decisions probabilities가 전체 선택지를 포함하지 않습니다.')
    distribution = {}
    for item in probabilities:
        if not isinstance(item, dict) or not _decision_number(item.get('probability')):
            raise DecisionsResponseError('Decisions probabilities 항목 형식이 잘못되었습니다.')
        index = _choice_index(values, item.get('value'))
        if index is None or index in distribution:
            raise DecisionsResponseError('Decisions probabilities 선택지가 예상 밖이거나 중복되었습니다.')
        distribution[index] = item['probability']
    # 부동소수점 직렬화 오차만 허용한다. confidence는 이 분포와 별도 값이다.
    if not math.isclose(sum(distribution.values()), 1, rel_tol=0, abs_tol=1e-6):
        raise DecisionsResponseError('Decisions probabilities 합이 1이 아닙니다.')
    if distribution[selected] + 1e-6 < max(distribution.values()):
        raise DecisionsResponseError('Decisions choice와 확률 분포가 일치하지 않습니다.')


class DecisionsClient:
    MAX_QUESTIONS = 400  # 요청당 질문 수 상한 (문서 기준)

    def __init__(self, base_url: str, api_key: str, model: str = DEFAULT_DECISIONS_MODEL):
        self.base_url, self.api_key, self.model = base_url.rstrip("/"), api_key, model
        self.before_request = None

    def decide(self, input_text: str, questions: list[dict]) -> dict[str, dict]:
        """전체 질문의 검증된 {name: 답}. 거절·누락·잘못된 답은 부분 성공 없이 실패한다."""
        names = set()
        for question in questions:
            if (not isinstance(question, dict) or not isinstance(question.get('name'), str)
                    or not question['name'] or question['name'] in names
                    or question.get('type') not in ('choice', 'predicate')):
                raise DecisionsResponseError('Decisions 질문의 name/type이 잘못되었거나 중복되었습니다.')
            names.add(question['name'])
        out: dict[str, dict] = {}
        for i in range(0, len(questions), self.MAX_QUESTIONS):
            batch = questions[i : i + self.MAX_QUESTIONS]
            if self.before_request:
                self.before_request()
            try:
                res = _post(f"{self.base_url}/decisions", self.api_key,
                            {"model": self.model, "input": input_text, "questions": batch})
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise DecisionsResponseError('Decisions 응답이 올바른 JSON이 아닙니다.') from error
            out.update(_validate_decision_answers(res, batch))
        return out


def decider_from_env() -> DecisionsClient | None:
    """OpenAI 기본 경로면 Decisions 를 쓴다 (AI_DECISIONS_MODEL, 비면 gpt-6-luna).
    다른 공급자는 AI_DECISIONS_MODEL 이 있을 때만 같은 AI_BASE_URL·AI_API_KEY 로 쓴다. None 이면 chat 모델 라벨 그대로."""
    model = os.environ.get("AI_DECISIONS_MODEL", "").strip()
    if _uses_openai_default():
        return DecisionsClient(OPENAI_API, os.environ["OPENAI_API_KEY"], model or DEFAULT_DECISIONS_MODEL)
    base, key = os.environ.get("AI_BASE_URL", "").strip(), os.environ.get("AI_API_KEY", "").strip()
    return DecisionsClient(base, key, model) if model and base and key else None
