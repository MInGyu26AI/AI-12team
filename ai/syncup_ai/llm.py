"""외부 AI 연결부. 분류·충돌 판정 코드는 이 인터페이스만 쓴다.

TODO(미정): 어떤 AI 서비스를 쓸지 확정되면 여기만 맞춘다.
지금은 OpenAI 호환 /chat/completions · /embeddings 형식만 구현 (OpenAI, 그리고 같은 형식을 지원하는 서비스).
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Protocol


class LLMNotConfigured(RuntimeError):
    pass


class LLMError(RuntimeError):
    pass


class LLM(Protocol):
    def chat_json(self, system: str, user: str) -> dict: ...


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


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
    if isinstance(data, list):  # 배열만 돌려준 경우
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
        detail = e.read().decode("utf-8", "replace")[:300]
        raise LLMError(f"AI 서버 오류 {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise LLMError(f"AI 서버 연결 실패: {e.reason}") from e


class OpenAICompatible:
    def __init__(self, base_url: str, api_key: str, model: str, json_mode: bool = True, embed_model: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.json_mode = json_mode
        self.embed_model = embed_model

    def chat_json(self, system: str, user: str) -> dict:
        body: dict = {
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        res = _post(f"{self.base_url}/chat/completions", self.api_key, body)
        try:
            content = res["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"예상과 다른 응답 형식: {str(res)[:200]}") from e
        return parse_json_reply(content)

    def embed(self, texts: list[str]) -> list[list[float]]:
        res = _post(f"{self.base_url}/embeddings", self.api_key, {"model": self.embed_model, "input": texts})
        return [d["embedding"] for d in sorted(res["data"], key=lambda d: d["index"])]


def from_env() -> OpenAICompatible:
    base, key, model = (os.environ.get(k, "").strip() for k in ("AI_BASE_URL", "AI_API_KEY", "AI_MODEL"))
    if not (base and key and model):
        raise LLMNotConfigured("외부 AI 설정 없음: ai/.env 에 AI_BASE_URL·AI_API_KEY·AI_MODEL 을 채워 주세요")
    return OpenAICompatible(
        base,
        key,
        model,
        json_mode=os.environ.get("AI_JSON_MODE", "true").lower() != "false",
        embed_model=os.environ.get("AI_EMBED_MODEL", "").strip(),
    )


def embedder_from_env() -> Embedder | None:
    """임베딩 모델이 설정돼 있을 때만. 없으면 None → 글자 n-gram 유사도 사용."""
    try:
        llm = from_env()
    except LLMNotConfigured:
        return None
    return llm if llm.embed_model else None


# ── OpenAI Decisions API (POST /v1/decisions) ──
# 자유 텍스트·JSON 스키마는 못 만들고, 질문마다 정형 답(choice / predicate / score)과 확률만 돌려준다.
# 그래서 문장 나누기·content·topic_key·담당자·기한은 chat 모델이, 라벨·충돌 판정·확신도는 Decisions 가 맡는다.
# 문서: https://developers.openai.com/api/docs/guides/decisions
# TODO(실제 호출 미검증): 키 받으면 응답 모양을 한 번 확인할 것. 형식이 다르면 이 클래스만 고친다.

def choice_q(name: str, instructions: str, choices: dict[str, str]) -> dict:
    return {"type": "choice", "name": name, "instructions": instructions,
            "choices": [{"value": v, "description": d} for v, d in choices.items()]}


def predicate_q(name: str, instructions: str) -> dict:
    return {"type": "predicate", "name": name, "instructions": instructions}


class Decider(Protocol):
    def decide(self, input_text: str, questions: list[dict]) -> dict[str, dict]: ...


class DecisionsClient:
    MAX_QUESTIONS = 400  # 요청당 질문 수 상한 (문서 기준)

    def __init__(self, base_url: str, api_key: str, model: str = "gpt-6-luna"):
        self.base_url, self.api_key, self.model = base_url.rstrip("/"), api_key, model

    def decide(self, input_text: str, questions: list[dict]) -> dict[str, dict]:
        """{질문 name: 답}. 답 예) choice → {"choice": "decision", "confidence": 0.91, ...}, predicate → {"probability": 0.8}
        거절(refusal)한 질문은 결과에서 빠진다."""
        out: dict[str, dict] = {}
        for i in range(0, len(questions), self.MAX_QUESTIONS):
            res = _post(f"{self.base_url}/decisions", self.api_key,
                        {"model": self.model, "input": input_text, "questions": questions[i : i + self.MAX_QUESTIONS]})
            for a in res.get("answers", []):
                if isinstance(a, dict) and a.get("name") and a.get("type") != "refusal":
                    out[a["name"]] = a
        return out


def decider_from_env() -> DecisionsClient | None:
    """AI_DECISIONS_MODEL 이 있으면 사용 (같은 AI_BASE_URL·AI_API_KEY). 없으면 None → chat 모델 라벨 그대로."""
    model = os.environ.get("AI_DECISIONS_MODEL", "").strip()
    base, key = os.environ.get("AI_BASE_URL", "").strip(), os.environ.get("AI_API_KEY", "").strip()
    return DecisionsClient(base, key, model) if model and base and key else None
