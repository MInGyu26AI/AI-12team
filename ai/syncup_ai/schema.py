"""AI 가 돌려준 카드를 docs/classification.md 4장 출력 형식(JSON) / shared/types.ts 에 맞게 정리.
모델 출력은 믿지 않고 여기서 한 번 더 고친다 (화면·서버가 깨지지 않게)."""
from __future__ import annotations

import re
from datetime import date
from typing import NamedTuple

from .config import BELOW_LOW_CONFIDENCE, LOW_CONFIDENCE
from .mask import has_mask_token, mask

SUBTOPICS = ("주제·목표", "자료 조사", "작업·결과물", "역할·일정", "과제 조건·피드백", "발표·제출", "기타")
TAGS = ("decision", "todo", "research", "none")


def _subtopic_key(s: str) -> str:
    return re.sub(r"[\s·/.,]", "", s)


# 모델이 자주 틀리게 쓰는 이름 → 정식 이름
_SUBTOPIC_ALIAS = {_subtopic_key(s): s for s in SUBTOPICS}
_TAG_ALIAS = {"결정": "decision", "할일": "todo", "할 일": "todo", "조사": "research", "제안": "none", "suggestion": "none"}

RELATED_FIELDS = (
    "sentence", "relevance", "subtopic", "tag", "topic_key", "is_new_topic", "content",
    "reason", "owner", "due", "is_change", "source", "masked", "confidence",
)


def norm_key(s: str) -> str:
    """띄어쓰기·대소문자만 다른 이름을 같게 본다 (세부 주제·결정 내용 비교)."""
    return re.sub(r"\s+", "", s).lower()


def _str_or_none(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s and s.lower() not in ("null", "none", "미정", "-") else None


def _conf(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.5
    x = min(max(x, 0.0), 1.0)
    rounded = round(x, 2)
    if x < LOW_CONFIDENCE <= rounded:  # 0.595 가 반올림으로 0.6 이 되면 '확인 필요'가 사라진다
        return BELOW_LOW_CONFIDENCE
    return rounded


def _due(v) -> str | None:
    s = _str_or_none(v)
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError:
        return None


def canonical_topic(topic: str | None, existing: list[str]) -> tuple[str | None, bool]:
    """기존 세부 주제와 띄어쓰기·대소문자만 다르면 기존 이름으로. (topic_key, is_new_topic)"""
    if not topic:
        return None, False
    for k in existing:
        if norm_key(k) == norm_key(topic):
            return k, False
    return topic, True


def normalize_card(
    raw: dict,
    *,
    source: str,
    pre_masked: bool,
    existing_topics: list[str],
    enabled_subtopics: list[str] | None = None,
) -> dict | None:
    """모델 카드 1장 → 출력 형식. 쓸 수 없는 카드면 None."""
    raw = {k: mask(v)[0] if isinstance(v, str) else v for k, v in raw.items()}
    source = mask(source)[0]
    relevance = str(raw.get("relevance", "")).strip().lower()
    confidence = _conf(raw.get("confidence"))
    model_masked = bool(raw.get("masked"))

    if relevance in ("personal", "개인"):
        # 개인: 내용은 남기지 않는다 (sentence 등 버림)
        return {"relevance": "personal", "source": source, "masked": pre_masked or model_masked, "confidence": confidence}
    if relevance not in ("related", "관련"):
        return None
    sentence = _str_or_none(raw.get("sentence"))
    if not sentence:
        return None
    return _related_card(raw, sentence, source, confidence, model_masked, existing_topics, enabled_subtopics)


def _related_card(raw: dict, sentence: str, source: str, confidence: float, model_masked: bool,
                  existing_topics: list[str], enabled_subtopics: list[str] | None) -> dict:
    content = _str_or_none(raw.get("content")) or sentence
    # 위에서 모든 값을 가렸지만 문장·내용·이유는 한 번 더 가린다. mask() 는 한 번에 끝나지 않을 수 있다
    # (앞 규칙이 바꾼 자리 뒤에서 새로 걸리는 값. 예: 주민번호에 바로 붙은 토큰).
    sentence, content = mask(sentence)[0], mask(content)[0]
    reason = _str_or_none(raw.get("reason"))
    if reason:
        reason = mask(reason)[0]
    # 이 카드 문장에 가림 표시가 있으면 true (발화 다른 부분만 가린 경우는 false). mask() 가 넣는 표시는 모두
    # MASK_TOKENS 에 있지만, 로컬 개인정보 게이트가 넣는 [비밀키]는 없어서 여기서 잡히지 않는다.
    masked = model_masked or has_mask_token(sentence + content)

    labels = _board_labels(raw, content, existing_topics, enabled_subtopics)
    tag, needs_check = labels.tag, labels.needs_check
    owner = _str_or_none(raw.get("owner")) if tag in ("decision", "todo") else None
    if tag == "todo" and not owner:
        needs_check = True  # 담당 미정 → 확인 필요
    if needs_check:
        confidence = min(confidence, BELOW_LOW_CONFIDENCE)

    return {
        "sentence": sentence,
        "relevance": "related",
        "subtopic": labels.subtopic,
        "tag": tag,
        "topic_key": labels.topic_key,
        "is_new_topic": bool(labels.topic_key) and labels.is_new_topic,
        "content": content,
        "reason": reason,
        "owner": owner,
        "due": _due(raw.get("due")) if tag == "todo" else None,
        "is_change": bool(raw.get("is_change")) and tag == "decision",
        "source": source,
        "masked": bool(masked),
        "confidence": confidence,
    }


class _BoardLabels(NamedTuple):
    tag: str
    subtopic: str | None
    topic_key: str | None
    is_new_topic: bool
    needs_check: bool  # 모르는 표시·빠진 이름을 채웠으면 True → 확인 필요


def _board_labels(raw: dict, content: str, existing_topics: list[str],
                  enabled_subtopics: list[str] | None) -> _BoardLabels:
    """보드에 묶을 표시·소주제·세부 주제. 모르는 표시·빠진 이름은 채우고 확인 필요로 둔다."""
    tag = str(raw.get("tag", "")).strip()
    tag = _TAG_ALIAS.get(tag, tag.lower())
    needs_check = tag not in TAGS
    if needs_check:
        tag = "none"
    subtopic = _str_or_none(raw.get("subtopic"))
    if subtopic:
        subtopic = _SUBTOPIC_ALIAS.get(_subtopic_key(subtopic))
    if subtopic and enabled_subtopics and subtopic not in enabled_subtopics:
        subtopic = "기타"  # 꺼 둔 소주제
    topic_key, is_new = canonical_topic(_str_or_none(raw.get("topic_key")), existing_topics)
    if tag != "none":
        # 공유 후보는 소주제·세부 주제가 꼭 있어야 보드에 묶인다
        if not subtopic:
            subtopic, needs_check = "기타", True
        if not topic_key:
            topic_key, is_new = canonical_topic(content.split("=")[0].strip()[:20] or "기타", existing_topics)
            needs_check = True
    return _BoardLabels(tag, subtopic, topic_key, is_new, needs_check)


def validate_output(card: dict) -> list[str]:
    """출력 형식 검사 (테스트·서버 입력 검사용). 문제 목록, 없으면 []."""
    errs: list[str] = []
    for f in ("relevance", "source", "masked", "confidence"):
        if f not in card:
            errs.append(f"필수 필드 없음: {f}")
    if card.get("relevance") == "personal":
        extra = set(card) - {"relevance", "source", "masked", "confidence", "id", "status"}
        if extra:
            errs.append(f"개인 카드에 내용 필드: {sorted(extra)}")
        return errs
    for f in RELATED_FIELDS:
        if f not in card:
            errs.append(f"필드 없음: {f}")
    if card.get("tag") not in TAGS:
        errs.append(f"tag 값 오류: {card.get('tag')}")
    if card.get("subtopic") is not None and card["subtopic"] not in SUBTOPICS:
        errs.append(f"subtopic 값 오류: {card.get('subtopic')}")
    if card.get("tag") != "none" and (not card.get("subtopic") or not card.get("topic_key")):
        errs.append("공유 후보인데 subtopic/topic_key 없음")
    if card.get("due") is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(card["due"])):
        errs.append(f"due 형식 오류: {card.get('due')}")
    c = card.get("confidence")
    if not isinstance(c, (int, float)) or not 0 <= c <= 1:
        errs.append(f"confidence 범위 오류: {c}")
    return errs
