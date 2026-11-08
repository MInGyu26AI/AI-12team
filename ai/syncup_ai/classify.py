"""발화 묶음 → 후보 카드 (docs/classification.md 4장 출력 형식).

입력은 shared/collector.ts NativeClassifyRequest, 출력은 NativeClassifyResponse 와 같은 모양.
순서: 형식형 민감정보 가림(코드) → 길이 자르기 → AI 분류 → 출력 정리(schema.normalize_card)
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from . import config
from .decide import relabel
from .llm import LLM, Decider
from .mask import mask, mask_text
from .schema import SUBTOPICS, normalize_card

KST = ZoneInfo("Asia/Seoul")
SITE_LABEL = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini", "codex": "Codex", "claude-code": "Claude Code"}


def _system_prompt() -> str:
    text = (config.PROMPTS / "classify_system.md").read_text(encoding="utf-8")
    return text.replace("{max_ai_cards}", str(config.MAX_CARDS_PER_AI_MESSAGE))


def _when(m: dict) -> datetime:
    try:
        d = datetime.fromisoformat(str(m.get("collectedAt", "")).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(KST)
    return d.astimezone(KST) if d.tzinfo else d.replace(tzinfo=KST)


def source_of(m: dict) -> str:
    """"ChatGPT, 2026-11-06 21:10" (수집기가 source 를 직접 넣었으면 그대로)."""
    if m.get("source"):
        return str(m["source"])
    site = str(m.get("site", ""))
    return f"{SITE_LABEL.get(site, site or '대화')}, {_when(m):%Y-%m-%d %H:%M}"


def _prepare(m: dict) -> tuple[str, bool]:
    text, masked = mask(str(m.get("text", "")))
    limit = config.MAX_AI_CHARS if m.get("role") == "assistant" else config.MAX_USER_CHARS
    if len(text) > limit:
        text = text[:limit] + " …(이하 생략)"
    return text, masked


def build_user_prompt(context: dict, messages: list[dict], context_messages: list[dict] | None = None) -> tuple[str, list[dict]]:
    """AI 에 보낼 사용자 메시지와 번호별 발화 정보 [{source, masked, role, context}]."""
    user = context.get("userName", "")
    names = context.get("knownNames") or []
    enabled = context.get("enabledSubtopics") or list(SUBTOPICS)
    topics = context.get("existingTopicKeys") or []
    decisions = context.get("existingDecisions") or []

    lines = [
        "# 팀 정보",
        f"- 팀 이름: {context.get('teamName', '')}",
        f"- 프로젝트 주제: {context.get('projectTopic', '')}",
        f"- 말한 사람(사용자): {user}",
        f"- 팀원: {', '.join(dict.fromkeys([user, *names])) or '(정보 없음)'}",
        f"- 켜 둔 소주제: {', '.join(enabled)}",
        f"- 기존 세부 주제: {', '.join(topics) if topics else '(없음)'}",
        "- 기존 팀 결정:",
        *([f"  - [{d.get('topic_key')}] {d.get('content')}" for d in decisions] or ["  (없음)"]),
        "",
        "# 발화",
    ]
    info: list[dict] = []
    for i, (m, is_ctx) in enumerate([(m, True) for m in (context_messages or [])] + [(m, False) for m in messages], start=1):
        text, masked = _prepare(m)
        who = "AI" if m.get("role") == "assistant" else "사용자"
        tag = " [참고용]" if is_ctx else ""
        lines.append(f"[{i}]{tag} {who} ({_when(m):%Y-%m-%d %H:%M}): {text}")
        info.append({"source": source_of(m), "masked": masked, "role": m.get("role"), "context": is_ctx})
    lines += ["", '위 발화를 분류해 {"cards": [...]} JSON 하나로만 답하세요.']
    # 발화는 위에서 가렸고, 팀 정보·기존 결정(사용자가 검토함에서 고친 내용일 수 있음)까지 외부로 나가기 전에 한 번 더
    return mask_text("\n".join(lines)), info


def classify_indexed(request: dict, llm: LLM, decider: Decider | None = None) -> list[tuple[int, dict]]:
    """(messages 안 0부터 센 위치, 카드) 목록. 평가 스크립트가 정답과 맞춰 볼 때 쓴다.

    1) chat 모델: 문장 나누기 + content·topic_key·담당자·기한 + 1차 라벨
    2) Decisions(있으면): 관련성·표시·소주제·변경 라벨과 확신도를 다시 매김 (실패하면 1차 라벨 유지)
    3) 출력 형식 정리 + 화자 규칙
    """
    context = request.get("context") or {}
    messages = request.get("messages") or []
    if not messages:
        return []
    prompt, info = build_user_prompt(context, messages, request.get("contextMessages"))
    reply = llm.chat_json(_system_prompt(), prompt)

    raw_cards = reply.get("cards")
    if not isinstance(raw_cards, list):
        raise ValueError("AI 응답에 cards 배열이 없음")

    valid: list[dict] = []
    for raw in raw_cards:
        if not isinstance(raw, dict):
            continue
        try:
            idx = int(raw.get("msg"))
        except (TypeError, ValueError):
            continue
        if not 1 <= idx <= len(info) or info[idx - 1]["context"]:
            continue  # 없는 번호 / 참고용 발화
        valid.append({**raw, "_msg": idx})

    enabled = context.get("enabledSubtopics") or None
    if decider is not None:
        try:
            valid = relabel(valid, prompt, decider, enabled)
        except Exception as e:  # Decisions 실패 → chat 모델 라벨 그대로
            print(f"[syncup_ai] Decisions 라벨 실패, chat 라벨 사용: {e}", file=sys.stderr)

    topics = list(context.get("existingTopicKeys") or [])
    ai_cards_per_msg: dict[int, int] = {}
    out: list[tuple[int, dict]] = []
    for raw in valid:
        idx = raw["_msg"]
        meta = info[idx - 1]
        card = normalize_card(raw, source=meta["source"], pre_masked=meta["masked"], existing_topics=topics, enabled_subtopics=enabled)
        if card is None:
            continue
        if meta["role"] == "assistant" and card["relevance"] == "related":
            if card["tag"] in ("decision", "todo"):
                card["tag"], card["owner"], card["due"], card["is_change"] = "none", None, None, False  # AI 말은 제안
            ai_cards_per_msg[idx] = ai_cards_per_msg.get(idx, 0) + 1
            if ai_cards_per_msg[idx] > config.MAX_CARDS_PER_AI_MESSAGE:
                continue
        if card["relevance"] == "related" and card["topic_key"] and card["topic_key"] not in topics:
            topics.append(card["topic_key"])  # 같은 묶음 안 다음 카드는 기존 주제로 봄
        out.append((idx, card))

    out.sort(key=lambda x: x[0])  # 발화 순서 유지 (같은 발화 안에서는 모델 순서)
    n_ctx = sum(1 for m in info if m["context"])
    return [(idx - 1 - n_ctx, c) for idx, c in out]


def classify(request: dict, llm: LLM, decider: Decider | None = None) -> list[dict]:
    return [c for _, c in classify_indexed(request, llm, decider)]


def handle_request(request: dict, llm: LLM, decider: Decider | None = None) -> dict:
    """NativeClassifyRequest → NativeClassifyResponse"""
    try:
        return {"ok": True, "cards": classify(request, llm, decider)}
    except Exception as e:  # 확장은 ok:false 를 받으면 목업 분류로 대체한다
        return {"ok": False, "error": f"분류 실패: {e}"}


if __name__ == "__main__":  # 프롬프트 확인용: python -m syncup_ai.classify < request.json
    import sys

    req = json.load(sys.stdin)
    print(build_user_prompt(req.get("context") or {}, req.get("messages") or [], req.get("contextMessages"))[0])
