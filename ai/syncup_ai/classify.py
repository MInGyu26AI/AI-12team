"""발화 묶음 → 후보 카드 (docs/classification.md 4장 출력 형식).

입력은 shared/collector.ts NativeClassifyRequest 모양(+ 선택 필드 contextMessages), 출력은 NativeClassifyResponse 와 같은 모양.
순서: 형식형 민감정보 가림(코드) → 길이 자르기 → AI 분류 → 출력 정리(schema.normalize_card)
"""
from __future__ import annotations

import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

from . import config
from .decide import relabel
from .llm import LLM, Decider, DecisionsResponseError, describe_failure
from .mask import mask, mask_text
from .evidence import locate_evidence
from .schema import SUBTOPICS, normalize_card

# A fixed UTC+9: Korea has kept no daylight saving time since 1988, and Windows has no time zone database for
# zoneinfo without the extra tzdata package.
KST = timezone(timedelta(hours=9), "KST")
# 발화 site → 카드 출처 이름(shared/labels.ts SITE_LABEL 과 같다). manual 은 대화 붙여넣기와 수집기에서 고친 입력
# (intake.retry), chatgpt-export 는 내보내기 파일이다.
SITE_LABEL = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini", "codex": "Codex", "claude-code": "Claude Code",
              "manual": "직접 입력", "chatgpt-export": "ChatGPT 내보내기"}


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
    return text, masked or bool(m.get('masked'))


def _team_criteria(context: dict) -> list[str]:
    """팀이 정한 목표·범위·규칙 (2차 최종 회의 '프로젝트 방향성 기준'). 없으면 아무 줄도 넣지 않는다."""
    rules = context.get("teamRules") or []
    if isinstance(rules, str):
        rules = [rules]
    lines = [f"- 팀 목표: {context['teamGoal']}"] if context.get("teamGoal") else []
    if context.get("teamScope"):
        lines.append(f"- 팀 범위: {context['teamScope']}")
    lines += [f"- 팀 규칙: {r}" for r in rules if isinstance(r, str) and r.strip()]
    return lines


def build_user_prompt(context: dict, messages: list[dict], context_messages: list[dict] | None = None) -> tuple[str, list[dict]]:
    """AI 에 보낼 사용자 메시지와 번호별 발화 정보 [{source, masked, role, context}]."""
    user = context.get("userName", "")
    names = context.get("knownNames") or []
    enabled = context.get("enabledSubtopics") or list(SUBTOPICS)  # 비어 있으면 모두 켬 (로컬 수집기 기본값이 [])
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
        *_team_criteria(context),
        "",
        "# 발화",
    ]
    info: list[dict] = []
    numbered = [(m, True) for m in context_messages or []] + [(m, False) for m in messages]
    for i, (m, is_ctx) in enumerate(numbered, start=1):
        text, masked = _prepare(m)
        who = "화자 미상" if m.get("roleGuessed") else ("AI" if m.get("role") == "assistant" else "사용자")
        tag = " [참고용]" if is_ctx else ""
        lines.append(f"[{i}]{tag} {who} ({_when(m):%Y-%m-%d %H:%M}): {text}")
        info.append({"source": source_of(m), "masked": masked, "role": m.get("role"), "context": is_ctx,
                     "text": text, "messageId": m.get("id"), "roleGuessed": bool(m.get("roleGuessed"))})
    lines += ["", '위 발화를 분류해 {"cards": [...]} JSON 하나로만 답하세요.']
    # 발화는 위에서 가렸고, 팀 정보·기존 결정(사용자가 검토함에서 고친 내용일 수 있음)까지 외부로 나가기 전에 한 번 더
    return mask_text("\n".join(lines)), info


def classify_indexed(request: dict, llm: LLM, decider: Decider | None = None) -> list[tuple[int, dict]]:
    """(messages 안 0부터 센 위치, 카드) 목록. 평가 스크립트가 정답과 맞춰 볼 때 쓴다.

    1) chat 모델: 문장 나누기 + content·topic_key·담당자·기한 + 1차 라벨
    2) Decisions(있으면): 관련성·표시·소주제·변경 라벨과 확신도를 다시 매김 (응답 검증 실패는 전파)
    3) 출력 형식 정리 + 화자 규칙
    """
    context = request.get("context") or {}
    messages = request.get("messages") or []
    if not messages:
        return []
    prompt, info = build_user_prompt(context, messages, request.get("contextMessages"))
    raw_cards = _numbered_cards(llm.chat_json(_system_prompt(), prompt), info)
    enabled = context.get("enabledSubtopics") or None
    if decider is not None:
        raw_cards = _relabel_or_keep(raw_cards, prompt, decider, enabled)
    out = _finish_cards(raw_cards, info, list(context.get("existingTopicKeys") or []), enabled)
    n_ctx = sum(1 for m in info if m["context"])
    return [(idx - 1 - n_ctx, c) for idx, c in out]


def _numbered_cards(reply: dict, info: list[dict]) -> list[dict]:
    """번호(msg)가 이번에 분류할 발화를 가리키는 카드만, 그 번호를 _msg 로 붙여서."""
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
    return valid


def _relabel_or_keep(cards: list[dict], prompt: str, decider: Decider, enabled: list[str] | None) -> list[dict]:
    """Decisions 라벨. 응답 검증 오류는 올리고, 다른 실패는 chat 라벨을 그대로 쓴다."""
    try:
        return relabel(cards, prompt, decider, enabled)
    except DecisionsResponseError:
        raise
    except Exception as e:
        print(f"[syncup_ai] Decisions 라벨 실패, chat 라벨 사용: {describe_failure(e)}", file=sys.stderr)
        return cards


def _finish_cards(raw_cards: list[dict], info: list[dict], topics: list[str],
                  enabled: list[str] | None) -> list[tuple[int, dict]]:
    """출력 형식으로 정리하고 화자 규칙을 적용한 (발화 번호, 카드) 목록. 발화 순서를 지킨다."""
    ai_cards_per_msg: Counter = Counter()
    out: list[tuple[int, dict]] = []
    for raw in raw_cards:
        idx = raw["_msg"]
        meta = info[idx - 1]
        card = normalize_card(raw, source=meta["source"], pre_masked=meta["masked"], existing_topics=topics,
                              enabled_subtopics=enabled)
        if card is None:
            continue
        # 화자를 추정한 발화는 AI 규칙을 적용하지 않는다. 실제 사용자 결정일 수 있어 확인 필요로 남기고
        # 검토함에서 화자를 확인받는다 (수집기 delivery 는 확인 전 전송을 막는다)
        if meta["role"] == "assistant" and not meta["roleGuessed"] and card["relevance"] == "related":
            if card["tag"] in ("decision", "todo"):
                card["tag"], card["owner"], card["due"], card["is_change"] = "none", None, None, False  # AI 말은 제안
            ai_cards_per_msg[idx] += 1
            if ai_cards_per_msg[idx] > config.MAX_CARDS_PER_AI_MESSAGE:
                continue
        if card["relevance"] == "related":
            try:
                _attach_evidence(card, raw, meta)
            except ValueError:
                if card["tag"] != "none":
                    raise  # 저장될 카드의 근거가 원문에 없으면 묶음 실패 (test_contract)
                continue  # 수집기가 저장하지 않는 제안 카드는 근거가 틀려도 묶음을 막지 않고 뺀다
        if card["relevance"] == "related" and card["topic_key"] and card["topic_key"] not in topics:
            topics.append(card["topic_key"])  # 같은 묶음 안 다음 카드는 기존 주제로 봄
        out.append((idx, card))
    out.sort(key=lambda x: x[0])  # 발화 순서 유지 (같은 발화 안에서는 모델 순서)
    return out


def _attach_evidence(card: dict, raw: dict, meta: dict) -> None:
    """관련 카드에 근거 위치와 분류 방법을 붙인다. 화자를 추정한 발화의 카드는 확인 필요로 낮춘다."""
    location = locate_evidence(card["sentence"], meta["text"], raw)
    card["evidence"] = {"messageId": meta["messageId"], "role": meta["role"],
                        "roleGuessed": meta["roleGuessed"], "quote": card["sentence"], **location}
    card["classificationMethod"] = raw.get("_labeled_by", "chat")
    if meta["roleGuessed"]:
        card["confidence"] = min(card["confidence"], config.BELOW_LOW_CONFIDENCE)


def classify(request: dict, llm: LLM, decider: Decider | None = None) -> list[dict]:
    return [c for _, c in classify_indexed(request, llm, decider)]


def handle_request(request: dict, llm: LLM, decider: Decider | None = None) -> dict:
    """NativeClassifyRequest → NativeClassifyResponse"""
    try:
        return {"ok": True, "cards": classify(request, llm, decider)}
    except Exception as e:  # 실패한 발화는 수집기가 보존하고 재시도한다.
        return {"ok": False, "error": f"분류 실패: {e}"}
