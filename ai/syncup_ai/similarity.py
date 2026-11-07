"""비슷한 결정 찾기. 임베딩이 있으면 임베딩, 없으면 글자 2-gram 코사인 (API 호출 없음)."""
from __future__ import annotations

import math
import re
from collections import Counter

from .llm import Embedder


def _bigrams(text: str) -> Counter:
    s = re.sub(r"[^\w가-힣]", "", text.lower())
    return Counter(s[i : i + 2] for i in range(len(s) - 1)) if len(s) > 1 else Counter([s])


def _cos(a, b) -> float:
    if isinstance(a, Counter):
        dot = sum(a[k] * b.get(k, 0) for k in a)
        na, nb = math.sqrt(sum(v * v for v in a.values())), math.sqrt(sum(v * v for v in b.values()))
    else:
        dot = sum(x * y for x, y in zip(a, b))
        na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def card_text(card: dict) -> str:
    return f"{card.get('topic_key') or ''} {card.get('content') or ''} {card.get('sentence') or ''}"


def similarities(query: dict, others: list[dict], embedder: Embedder | None = None) -> list[float]:
    if not others:
        return []
    texts = [card_text(query)] + [card_text(c) for c in others]
    if embedder is not None:
        try:
            vecs = embedder.embed(texts)
            return [_cos(vecs[0], v) for v in vecs[1:]]
        except Exception:
            pass  # 임베딩 실패 → n-gram 으로
    grams = [_bigrams(t) for t in texts]
    return [_cos(grams[0], g) for g in grams[1:]]
