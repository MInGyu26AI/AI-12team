"""분류 정확도·충돌 감지율 평가.

  python3 -m eval.run classify            # 22개 예시 분류 (외부 AI 필요)
  python3 -m eval.run conflict            # 충돌 판정 (외부 AI 필요)
  python3 -m eval.run conflict --rule     # AI 없이 규칙 판정 기준선
  결과는 eval/results/ 에 JSON 으로 저장 (커밋 안 됨)
  검사를 끝내지 못한 묶음·쌍(낮은 확신도 등)은 incomplete 로 세고 정확도 계산에서 뺀다.
"""
from __future__ import annotations

import json
import sys
from collections import Counter

from syncup_ai.config import LOW_CONFIDENCE, load_env
from syncup_ai.llm import LLMNotConfigured, decider_from_env, from_env

from .gold import CLASS, CONFLICT_PAIRS, EXAMPLES, HACKATHON
from .scoring import alert_rates, classify_positions, judge, save_result, should_alert

TIME = "2026-11-06T12:00:00Z"  # = KST 21:00


def _requests():
    """팀 종류별로 한 묶음씩 (실제처럼 여러 발화를 한 번에 분류)."""
    for team, ctx in (("hack", HACKATHON), ("class", CLASS)):
        idx = [i for i, (t, _, _) in enumerate(EXAMPLES) if t == team]
        msgs = [{"id": f"m{i}", "site": "chatgpt", "role": "user", "text": EXAMPLES[i][1],
                 "conversationId": team, "collectedAt": TIME} for i in idx]
        yield idx, {"type": "classify", "version": 1, "context": ctx, "messages": msgs}


def _match(expected: list[dict], got: list[dict]) -> list[tuple[dict, dict | None]]:
    """기대 카드마다 같은 tag 를 먼저, 없으면 남은 것 중 앞에서부터 짝짓기."""
    left = list(got)
    pairs = []
    for e in expected:
        pick = next((g for g in left if g.get("tag") == e.get("tag") and g["relevance"] == e["relevance"]), None)
        pick = pick or next((g for g in left if g["relevance"] == e["relevance"]), None) or (left[0] if left else None)
        if pick:
            left.remove(pick)
        pairs.append((e, pick))
    return pairs


def _score_example(expected: list[dict], got: list[dict], score: Counter, total: Counter) -> None:
    exp_rel = "personal" if all(e["relevance"] == "personal" for e in expected) else "related"
    got_rel = "related" if any(c["relevance"] == "related" for c in got) else "personal"
    total["relevance"] += 1
    score["relevance"] += exp_rel == got_rel
    if exp_rel == "personal" and got_rel == "related":
        score["personal_leak"] += 1  # 개인 내용이 공유 후보로 새는 경우 (가장 나쁨)
    total["card_count"] += 1
    same_count = (sum(c["relevance"] == "related" for c in got)
                  == sum(e["relevance"] == "related" for e in expected))
    score["card_count"] += same_count or (exp_rel == got_rel == "personal")
    for e, g in _match(expected, got):
        if e["relevance"] == "personal":
            continue
        for f in ("tag", "subtopic", "topic_key", "owner", "due", "is_change", "masked"):
            if f in e and (f != "subtopic" or e["tag"] != "none"):
                total[f] += 1
                score[f] += bool(g) and g.get(f) == e[f]
        if e.get("low_conf"):
            total["low_conf"] += 1
            score["low_conf"] += bool(g) and g["confidence"] < LOW_CONFIDENCE


def eval_classify(llm, decider=None) -> dict:
    score: Counter = Counter()
    total: Counter = Counter()
    rows, incomplete = [], 0
    for idx, req in _requests():
        out, failure = classify_positions(req, llm, decider)
        for pos, ex_i in enumerate(idx):
            _, sentence, expected = EXAMPLES[ex_i]
            if failure:
                incomplete += 1
                rows.append({"sentence": sentence, "expected": expected, "failure": failure})
                continue
            got = [c for p, c in out if p == pos]
            _score_example(expected, got, score, total)
            rows.append({"sentence": sentence, "expected": expected, "got": got})
    acc = {k: round(score[k] / total[k], 3) for k in total}
    acc["personal_leak_count"] = score["personal_leak"]
    acc["incomplete"] = incomplete
    return {"accuracy": acc, "rows": rows}


def eval_conflict(llm, decider=None) -> dict:
    outcomes, rows, exact = [], [], 0
    for old, new, want in CONFLICT_PAIRS:
        judged, conflicts, failure = judge(new, [old], llm, decider)
        if failure:
            rows.append({"old": old["content"], "new": new["content"], "want": want, "got": f"미완료:{failure}",
                         "reason": None})
            continue
        got = judged[0]["judgement"]
        outcomes.append((should_alert(want), bool(conflicts)))
        exact += got == want
        rows.append({"old": old["content"], "new": new["content"], "want": want, "got": got, "reason": judged[0]["reason"]})
    return {
        **alert_rates(outcomes),
        "judgement_accuracy": round(exact / max(len(outcomes), 1), 3),
        "incomplete": len(CONFLICT_PAIRS) - len(outcomes),
        "rows": rows,
    }


def main() -> int:
    load_env()
    what = sys.argv[1] if len(sys.argv) > 1 else "classify"
    rule = "--rule" in sys.argv
    llm = None
    if not rule:
        try:
            llm = from_env()
        except LLMNotConfigured as e:
            print(e, file=sys.stderr)
            return 1
    if what == "classify":
        if llm is None:
            print("분류 평가는 외부 AI 가 필요합니다.", file=sys.stderr)
            return 1
        res = eval_classify(llm, decider_from_env())
        summary = res["accuracy"]
    else:
        res = eval_conflict(llm, None if rule else decider_from_env())
        summary = {k: v for k, v in res.items() if k != "rows"}
        for r in res["rows"]:
            mark = "✓" if r["got"] == r["want"] else "✗"
            print(f"{mark} [{r['want']} → {r['got']}] {r['old']}  vs  {r['new']}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"저장: {save_result(what + ('-rule' if rule else ''), res)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
