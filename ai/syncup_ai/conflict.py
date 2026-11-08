"""결정 충돌 판정: 새로 승인된 결정 ↔ 팀 보드의 기존 결정.

1) 후보 찾기: 유효 승인 결정을 주제·유사도 순으로 정렬 (키·유사도로 제외하지 않음)
2) AI 판정: CONFLICT_TOP_K 개씩 전부 비교. 한도 초과·일부 실패는 전체 검사 실패
3) 충돌(설정에 따라 변경도) → shared/types.ts Conflict 객체
판정 순서: Decisions API → chat 모델 → 규칙(같은 topic_key + 다른 내용, 결정자가 같으면 변경·다르면 충돌).
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import time

from . import config
from .decide import judge_pairs
from .llm import LLM, Decider, Embedder, LLMError, RetryableLLMError
from .similarity import similarities
from .mask import mask_text

JUDGEMENTS = ("같음", "변경", "충돌", "무관")


class LowConfidenceError(ValueError):
    pass


def _is_decision(c: dict) -> bool:
    return (c.get("relevance") == "related" and c.get("tag") == "decision"
            and c.get("status", "approved") == "approved"
            and c.get("decisionState", "active") in ("active", "review"))


def find_candidates(new: dict, existing: list[dict], embedder: Embedder | None = None) -> list[dict]:
    pool = ordered_candidates(new, existing)
    if not pool:
        return []
    if len(pool) > config.CONFLICT_MAX_CANDIDATES:
        raise ValueError("충돌 비교 개수 한도를 초과했습니다. 검사 미완료입니다.")
    if len(json.dumps([_brief(new), *map(_brief, pool)], ensure_ascii=False)) > config.CONFLICT_MAX_INPUT_CHARS:
        raise ValueError("충돌 비교 입력 크기 한도를 초과했습니다. 검사 미완료입니다.")
    return pool


def ordered_candidates(new: dict, existing: list[dict]) -> list[dict]:
    """Durable workers snapshot all eligible IDs; synchronous callers retain their request budget."""
    topic = _norm(new.get("topic_key") or "")
    pool = [c for c in existing if _is_decision(c) and c.get("id") != new.get("id")]
    # 순서만 정하므로 외부 임베딩 호출 없이 기존 로컬 유사도를 사용한다.
    scores = similarities(new, pool)
    return [c for c, _ in sorted(zip(pool, scores),
            key=lambda pair: (bool(topic) and _norm(pair[0].get("topic_key") or "") == topic, pair[1]),
            reverse=True)]


def _brief(c: dict) -> dict:
    keys = ("id", "content", "sentence", "reason", "owner", "source", "is_change")
    return {k: mask_text(v) if isinstance(v, str) else v for k, v in ((k, c.get(k)) for k in keys)}


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


def ai_judge(new: dict, candidates: list[dict], llm: LLM, allow_rules: bool = True) -> list[dict]:
    system = (config.PROMPTS / "conflict_system.md").read_text(encoding="utf-8")
    user = (
        "# 새 결정\n" + json.dumps(_brief(new), ensure_ascii=False)
        + "\n\n# 기존 결정\n" + "\n".join(json.dumps(_brief(c), ensure_ascii=False) for c in candidates)
        + '\n\n기존 결정마다 판정해 {"results": [...]} JSON 하나로만 답하세요.'
    )
    reply = llm.chat_json(system, mask_text(user))
    if not allow_rules:
        rows = reply.get('results')
        if (not isinstance(rows, list) or len(rows) != len(candidates)
                or any(not isinstance(row, dict) for row in rows)
                or {row.get('id') for row in rows} != {c.get('id') for c in candidates}):
            raise ValueError('충돌 판정 응답의 대상이 누락되거나 중복되었습니다.')
    by_id = {str(r.get("id")): r for r in reply.get("results", []) if isinstance(r, dict)}
    out = []
    for c in candidates:
        r = by_id.get(str(c.get("id")))
        if not r or r.get("judgement") not in JUDGEMENTS:
            if not allow_rules:
                raise ValueError("충돌 판정 응답이 누락되었습니다.")
            out.append({**rule_judge(new, c), "method": "rule"})
            continue
        out.append({
            "id": c.get("id"),
            "judgement": r["judgement"],
            "reason": str(r.get("reason") or "").strip() or rule_judge(new, c)["reason"],
            "confidence": r.get("confidence", 0.0),
            "method": "chat",
        })
    return out


def conflict_id(old: dict, new: dict) -> str:
    return "x" + hashlib.sha1(f"{old.get('id')}|{new.get('id')}".encode()).hexdigest()[:10]


def _confident(result: dict) -> bool:
    value = result.get("confidence")
    return (type(value) in (int, float) and math.isfinite(value)
            and config.LOW_CONFIDENCE <= value <= 1)


def check_new_decision(
    new: dict, existing: list[dict], llm: LLM | None = None, embedder: Embedder | None = None,
    decider: Decider | None = None,
    allow_rules: bool = True,
) -> tuple[list[dict], list[dict]]:
    """(판정 목록, Conflict 목록). 결정이 아니면 둘 다 []."""
    if not _is_decision(new):
        return [], []
    deadline = time.monotonic() + config.CONFLICT_CHECK_SECONDS
    candidates = find_candidates(new, existing, embedder)
    if not candidates:
        return [], []
    judged = []
    for start in range(0, len(candidates), config.CONFLICT_TOP_K):
        if time.monotonic() >= deadline:
            raise ValueError("충돌 비교 시간 한도를 초과했습니다. 검사 미완료입니다.")
        batch = candidates[start:start + config.CONFLICT_TOP_K]
        result = None
        transport_error = None
        if decider is not None:  # 1순위: Decisions (확률 기반 판정)
            try:
                result = [{**r, "method": "decisions"} for r in judge_pairs(new, batch, decider)]
            except RetryableLLMError as error:
                transport_error = error
        if time.monotonic() >= deadline:
            raise ValueError("충돌 비교 시간 한도를 초과했습니다. 검사 미완료입니다.")
        if result is None and llm is not None:  # 일시적인 통신 실패만 기존 chat 경로로 대체한다.
            try:
                result = ai_judge(new, batch, llm, allow_rules)
            except RetryableLLMError as error:
                transport_error = error
        if time.monotonic() >= deadline:
            raise ValueError("충돌 비교 시간 한도를 초과했습니다. 검사 미완료입니다.")
        if result is None:
            if not allow_rules:
                if transport_error is not None:
                    raise transport_error
                raise ValueError("AI 충돌 검사를 완료하지 못했습니다. 재시도가 필요합니다.")
            result = [{**rule_judge(new, c), "method": "rule"} for c in batch]
        for index, judgement in enumerate(result):
            if judgement['method'] != 'decisions' or _confident(judgement) or llm is None:
                continue
            if time.monotonic() >= deadline:
                raise LowConfidenceError('확인 필요: 독립 검토 시간을 초과했습니다.')
            candidate = next(c for c in batch if c['id'] == judgement['id'])
            try:
                review = ai_judge(new, [candidate], llm, allow_rules=False)[0]
                if not _confident(review) or time.monotonic() >= deadline:
                    continue
                # 검토자의 결론은 Decisions에 전달하지 않는다. 두 독립 판정이 모두 기준을 넘어야 한다.
                confirmed = judge_pairs(new, [candidate], decider, with_owner_evidence=True)[0]
                if (time.monotonic() < deadline and _confident(confirmed)
                        and confirmed['judgement'] == review['judgement']):
                    result[index] = dict(confirmed, method='decisions', reviewedBy='chat',
                                         reviewConfidence=review['confidence'],
                                         confidence=min(confirmed['confidence'], review['confidence']))
            except (LLMError, ValueError, TypeError):
                # 보완 검토 실패로 최초의 불확실한 판정을 자동 통신 재시도로 바꾸지 않는다.
                continue
        if any(j["method"] != "rule" and not _confident(j) for j in result):
            raise LowConfidenceError("확인 필요: AI 판정의 확신도가 부족합니다. 검사 미완료입니다.")
        judged.extend(result)

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
                "confidence": r["confidence"],
                "method": r["method"],
                **({"reviewedBy": r['reviewedBy']} if 'reviewedBy' in r else {}),
            })
    return judged, conflicts


def handle_request(request: dict, llm: LLM | None, embedder: Embedder | None = None, decider: Decider | None = None, *, allow_rules: bool = True) -> dict:
    """{"newCards": [...], "existing": [...]} → {"ok", "results": [{cardId, judgements}], "conflicts": [...]}

    새 카드끼리도 비교한다 (한 번에 여러 장 승인할 때 앞 카드가 '기존'이 됨)."""
    try:
        existing = list(request.get("existing") or [])
        results, conflicts = [], []
        for card in request.get("newCards") or []:
            judged, found = check_new_decision(card, existing, llm, embedder, decider, allow_rules)
            results.append({"cardId": card.get("id"), "judgements": judged})
            conflicts += found
            existing.append(card)
        degraded = any(j.get("method") == "rule" for r in results for j in r["judgements"])
        return {"ok": True, "results": results, "conflicts": conflicts,
                "checkStatus": "degraded" if degraded else "complete"}
    except Exception as e:
        return {"ok": False, "checkStatus": "failed", "error": f"충돌 검사 실패: {e}",
                "failureReason": "low-confidence" if isinstance(e, LowConfidenceError) else
                                 "communication" if isinstance(e, RetryableLLMError) else "check-failed",
                "retryable": isinstance(e, RetryableLLMError)}
