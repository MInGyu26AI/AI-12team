"""결정 충돌 판정: 새로 승인된 결정 ↔ 팀 보드의 기존 결정.

1) 후보 찾기: 같은 topic_key 결정 + 내용이 비슷한 결정 (상위 CONFLICT_TOP_K 개)
2) AI 판정: 같음 / 변경 / 충돌 / 무관 + 이유
3) 충돌(설정에 따라 변경도) → shared/types.ts Conflict 객체
판정 순서: Decisions API → chat 모델 → 규칙(같은 topic_key + 다른 내용, 결정자가 같으면 변경·다르면 충돌).
"""
from __future__ import annotations

import hashlib
import json
import re

from . import config
from .decide import judge_pairs
from .llm import LLM, Decider, Embedder
from .similarity import similarities

JUDGEMENTS = ("같음", "변경", "충돌", "무관")


def _is_decision(c: dict) -> bool:
    return c.get("relevance") == "related" and c.get("tag") == "decision"


def find_candidates(new: dict, existing: list[dict], embedder: Embedder | None = None) -> list[dict]:
    pool = [c for c in existing if _is_decision(c) and c.get("id") != new.get("id")]
    if not pool:
        return []
    sims = similarities(new, pool, embedder)
    scored = []
    for c, s in zip(pool, sims):
        same_topic = bool(new.get("topic_key")) and c.get("topic_key") == new.get("topic_key")
        if same_topic or s >= config.SIMILARITY_MIN:
            scored.append((1 if same_topic else 0, s, c))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)  # 같은 세부 주제 먼저, 그다음 유사도
    return [c for _, _, c in scored[: config.CONFLICT_TOP_K]]


def _brief(c: dict) -> dict:
    keys = ("id", "topic_key", "content", "sentence", "reason", "owner", "source", "is_change")
    return {k: c.get(k) for k in keys}


def _norm(content: str) -> str:
    return re.sub(r"\s+", "", content).lower()


def rule_judge(new: dict, old: dict) -> dict:
    """AI 없이 쓰는 판정 (오프라인·실패 대비). 같은 세부 주제만 비교."""
    if new.get("topic_key") != old.get("topic_key"):
        return {"id": old.get("id"), "judgement": "무관", "reason": "세부 주제가 다름", "confidence": 0.4}
    if _norm(new.get("content") or "") == _norm(old.get("content") or ""):
        return {"id": old.get("id"), "judgement": "같음", "reason": "같은 세부 주제의 같은 내용", "confidence": 0.6}
    # 정답표(conflict_key K1·K5·K6·K12): 같은 사람이 고치거나 팀 합의로 바꾸면 변경, 다른 사람이 반대로 정하면 충돌
    same_owner = bool(new.get("owner")) and new.get("owner") == old.get("owner")
    team_agreed = bool(re.search(r"팀에서|다들|모두|합의|회의에서", new.get("sentence") or ""))
    j = "변경" if same_owner or team_agreed else "충돌"
    reason = (
        f"같은 세부 주제({old.get('topic_key')})의 기존 결정 '{old.get('content')}'"
        f"{'을(를) 바꾸는 표현' if j == '변경' else '과(와) 다른 내용'}: '{new.get('content')}'"
    )
    return {"id": old.get("id"), "judgement": j, "reason": reason, "confidence": 0.5}


def ai_judge(new: dict, candidates: list[dict], llm: LLM) -> list[dict]:
    system = (config.PROMPTS / "conflict_system.md").read_text(encoding="utf-8")
    user = (
        "# 새 결정\n" + json.dumps(_brief(new), ensure_ascii=False)
        + "\n\n# 기존 결정\n" + "\n".join(json.dumps(_brief(c), ensure_ascii=False) for c in candidates)
        + '\n\n기존 결정마다 판정해 {"results": [...]} JSON 하나로만 답하세요.'
    )
    reply = llm.chat_json(system, user)
    by_id = {str(r.get("id")): r for r in reply.get("results", []) if isinstance(r, dict)}
    out = []
    for c in candidates:
        r = by_id.get(str(c.get("id")))
        if not r or r.get("judgement") not in JUDGEMENTS:
            out.append(rule_judge(new, c))  # 빠뜨린 건 규칙으로
            continue
        out.append({
            "id": c.get("id"),
            "judgement": r["judgement"],
            "reason": str(r.get("reason") or "").strip() or rule_judge(new, c)["reason"],
            "confidence": r.get("confidence", 0.7),
        })
    return out


def conflict_id(old: dict, new: dict) -> str:
    return "x" + hashlib.sha1(f"{old.get('id')}|{new.get('id')}".encode()).hexdigest()[:10]


def check_new_decision(
    new: dict, existing: list[dict], llm: LLM | None = None, embedder: Embedder | None = None,
    decider: Decider | None = None,
) -> tuple[list[dict], list[dict]]:
    """(판정 목록, Conflict 목록). 결정이 아니면 둘 다 []."""
    if not _is_decision(new):
        return [], []
    candidates = find_candidates(new, existing, embedder)
    if not candidates:
        return [], []
    judged = None
    if decider is not None:  # 1순위: Decisions (확률 기반 판정)
        try:
            judged = judge_pairs(new, candidates, decider)
        except Exception:
            judged = None
    if judged is None and llm is not None:  # 2순위: chat 모델
        try:
            judged = ai_judge(new, candidates, llm)
        except Exception:
            judged = None
    if judged is None:
        judged = [rule_judge(new, c) for c in candidates]

    alert = {"충돌", "변경"} if config.CONFLICT_ON_CHANGE else {"충돌"}
    by_id = {c.get("id"): c for c in candidates}
    conflicts = []
    for r in judged:
        if r["judgement"] in alert:
            old = by_id[r["id"]]
            conflicts.append({
                "id": conflict_id(old, new),
                "topic_key": old.get("topic_key") or new.get("topic_key"),
                "cardA": old,  # 기존 결정
                "cardB": new,  # 새 결정
                "judgement": r["judgement"],
                "reason": r["reason"],
            })
    return judged, conflicts


def handle_request(request: dict, llm: LLM | None, embedder: Embedder | None = None, decider: Decider | None = None) -> dict:
    """{"newCards": [...], "existing": [...]} → {"ok", "results": [{cardId, judgements}], "conflicts": [...]}

    새 카드끼리도 비교한다 (한 번에 여러 장 승인할 때 앞 카드가 '기존'이 됨)."""
    try:
        existing = list(request.get("existing") or [])
        results, conflicts = [], []
        for card in request.get("newCards") or []:
            judged, found = check_new_decision(card, existing, llm, embedder, decider)
            results.append({"cardId": card.get("id"), "judgements": judged})
            conflicts += found
            existing.append(card)
        return {"ok": True, "results": results, "conflicts": conflicts}
    except Exception as e:
        return {"ok": False, "error": f"충돌 검사 실패: {e}"}
