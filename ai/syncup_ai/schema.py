"""AI 가 돌려준 카드를 docs/classification.md 4장 출력 형식(JSON) / shared/types.ts 에 맞게 정리.
모델 출력은 믿지 않고 여기서 한 번 더 고친다 (화면·서버가 깨지지 않게)."""
from __future__ import annotations

import re
from datetime import date

from .config import LOW_CONFIDENCE
from .mask import has_mask_token, mask

SUBTOPICS = ("주제·목표", "자료 조사", "작업·결과물", "역할·일정", "과제 조건·피드백", "발표·제출", "기타")
TAGS = ("decision", "todo", "research", "none")

# 모델이 자주 틀리게 쓰는 이름 → 정식 이름
_SUBTOPIC_ALIAS = {re.sub(r"[\s·/.,]", "", s): s for s in SUBTOPICS}
_TAG_ALIAS = {"결정": "decision", "할일": "todo", "할 일": "todo", "조사": "research", "제안": "none", "suggestion": "none"}

RELATED_FIELDS = (
    "sentence", "relevance", "subtopic", "tag", "topic_key", "is_new_topic", "content",
    "reason", "owner", "due", "is_change", "source", "masked", "confidence",
)


def _norm_key(s: str) -> str:
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
    return round(min(max(x, 0.0), 1.0), 2)


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
        if _norm_key(k) == _norm_key(topic):
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
    relevance = str(raw.get("relevance", "")).strip().lower()
    confidence = _conf(raw.get("confidence"))
    model_masked = bool(raw.get("masked"))

    if relevance in ("personal", "개인"):
        # 개인: 내용은 남기지 않는다 (sentence 등 버림)
        return {"relevance": "personal", "source": source, "masked": pre_masked or model_masked, "confidence": confidence}
    if relevance not in ("related", "관련"):
        return None

    sentence = _str_or_none(raw.get("sentence"))
    content = _str_or_none(raw.get("content")) or sentence
    if not sentence:
        return None
    # 모델이 놓친 형식형 민감정보를 한 번 더 가림
    sentence, m1 = mask(sentence)
    content, m2 = mask(content)
    reason = _str_or_none(raw.get("reason"))
    if reason:
        reason, _ = mask(reason)
    # 이 카드 문장에 가림 표시가 있으면 true (발화 다른 부분만 가린 경우는 false)
    masked = m1 or m2 or model_masked or has_mask_token(sentence + content)

    tag = str(raw.get("tag", "")).strip()
    tag = _TAG_ALIAS.get(tag, tag.lower())
    if tag not in TAGS:
        tag, confidence = "none", min(confidence, LOW_CONFIDENCE - 0.01)

    subtopic = _str_or_none(raw.get("subtopic"))
    if subtopic:
        subtopic = _SUBTOPIC_ALIAS.get(re.sub(r"[\s·/.,]", "", subtopic))
    if subtopic and enabled_subtopics and subtopic not in enabled_subtopics:
        subtopic = "기타"  # 꺼 둔 소주제

    topic_key, is_new = canonical_topic(_str_or_none(raw.get("topic_key")), existing_topics)

    if tag != "none":
        # 공유 후보는 소주제·세부 주제가 꼭 있어야 보드에 묶인다
        if not subtopic:
            subtopic, confidence = "기타", min(confidence, LOW_CONFIDENCE - 0.01)
        if not topic_key:
            topic_key, is_new = canonical_topic(content.split("=")[0].strip()[:20] or "기타", existing_topics)
            confidence = min(confidence, LOW_CONFIDENCE - 0.01)

    owner = _str_or_none(raw.get("owner")) if tag in ("decision", "todo") else None
    due = _due(raw.get("due")) if tag == "todo" else None
    is_change = bool(raw.get("is_change")) and tag == "decision"
    if tag == "todo" and not owner:
        confidence = min(confidence, LOW_CONFIDENCE - 0.01)  # 담당 미정 → 확인 필요

    return {
        "sentence": sentence,
        "relevance": "related",
        "subtopic": subtopic,
        "tag": tag,
        "topic_key": topic_key,
        "is_new_topic": bool(topic_key) and is_new,
        "content": content,
        "reason": reason,
        "owner": owner,
        "due": due,
        "is_change": is_change,
        "source": source,
        "masked": bool(masked),
        "confidence": confidence,
    }


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
