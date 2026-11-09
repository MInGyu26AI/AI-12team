"""비슷한 결정 찾기: 글자 2-gram 코사인 (API 호출 없음). 충돌 후보의 비교 순서를 정하는 데만 쓴다."""
from __future__ import annotations

import math
import re
from collections import Counter



def _bigrams(text: str) -> Counter:
    s = re.sub(r"[^\w가-힣]", "", text.lower())
    return Counter(s[i : i + 2] for i in range(len(s) - 1)) if len(s) > 1 else Counter([s])


def _cos(a: Counter, b: Counter) -> float:
    dot = sum(a[k] * b.get(k, 0) for k in a)
    na, nb = math.sqrt(sum(v * v for v in a.values())), math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def card_text(card: dict) -> str:
    return f"{card.get('topic_key') or ''} {card.get('content') or ''} {card.get('sentence') or ''}"


def similarities(query: dict, others: list[dict]) -> list[float]:
    if not others:
        return []
    texts = [card_text(query)] + [card_text(c) for c in others]
    grams = [_bigrams(t) for t in texts]
    return [_cos(grams[0], g) for g in grams[1:]]
