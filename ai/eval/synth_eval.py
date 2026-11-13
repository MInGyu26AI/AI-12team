"""합성 팀 대화 30개로 평가 (eval/synth 가 만든 data/synth_*.csv).

  python3 -m eval.synth_eval judge [--split dev|test] [--rule]   충돌 판정 A: 심어 둔 쌍에 정답 카드를 넣음
  python3 -m eval.synth_eval e2e [--split dev|test]              전체 흐름 B: 분류부터 충돌까지 (외부 AI 필요)
  결과: eval/results/synth-*.json

채점은 eval/sheet_eval.py 와 같다. 대화(팀)마다 팀 정보를 넘기고, 충돌 비교는 팀 안에서만 한다.
시험용(test)은 프롬프트를 고친 뒤 마지막 측정에만 쓴다.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime

from syncup_ai.config import load_env
from syncup_ai.llm import LLMNotConfigured, decider_from_env, from_env

from .scoring import alert_rates, save_result, should_alert
from .sheet_eval import TAG, eval_e2e, eval_judge, run_classify, score_classify
from .sheets import DATA, read_table


def load(split: str):
    """대화별 (팀 정보, 발화, 정답 문장, 결정 쌍)."""
    convs = defaultdict(lambda: {"msgs": [], "gold": [], "pairs": []})
    asker = ""
    for r in read_table(DATA / "synth_conversations.csv"):
        if r["split"] != split:
            continue
        at = datetime.fromisoformat(f"{r['date']}T{r['time']}")
        c = convs[r["conv_id"]]
        c["context"] = {"teamName": r["team"], "projectTopic": r["topic"]}
        is_ai = r["speaker"] == "ChatGPT"
        asker = asker if is_ai else r["speaker"]  # AI 답변은 바로 앞에 물어본 팀원의 대화에 들어간다
        c["msgs"].append({
            "id": r["message_id"], "site": "chatgpt", "member": asker,
            "role": "assistant" if is_ai else "user", "text": r["text"],
            "conversationId": f"{r['conv_id']}-{asker}-{at:%m%d}", "conversationTitle": "", "url": "",
            "collectedAt": at.strftime("%Y-%m-%dT%H:%M:%S+09:00"), "_at": at,
        })
    texts = {}
    for u in read_table(DATA / "synth_answer_key.csv"):
        texts[u["unit_id"]] = u["text"]
        if u["conv_id"] not in convs:
            continue
        convs[u["conv_id"]]["gold"].append({
            "unit": u["unit_id"], "message_id": u["message_id"], "text": u["text"],
            "relevance": "personal" if u["relevance"] == "개인" else "related",
            "subtopic": u["subtopic"] or None,
            "tag": next((v for k, v in TAG.items() if u["tag"].startswith(k)), None),
            "topic_key": u["topic_key"] or None, "owner": u["owner_or_source"] or None, "due": u["due"] or None,
            "is_change": u["is_change"] == "1", "masked": u["masked"] == "1",
        })
    for p in read_table(DATA / "synth_conflict_key.csv"):
        if p["conv_id"] in convs:
            convs[p["conv_id"]]["pairs"].append({
                "pair_id": f"{p['conv_id']}:{p['old_unit']}>{p['new_unit']}", "old_unit": p["old_unit"],
                "new_unit": p["new_unit"], "label": p["label"],
                "old_text": texts[p["old_unit"]], "new_text": texts[p["new_unit"]]})
    for c in convs.values():
        members = list(dict.fromkeys(m["member"] for m in c["msgs"] if m["role"] == "user"))
        c["context"]["knownNames"] = members
        c["msgs"].sort(key=lambda m: m["_at"])
    return dict(sorted(convs.items()))


def run_judge(convs, llm, decider) -> dict:
    gold = [g for c in convs.values() for g in c["gold"]]
    pairs = [p for c in convs.values() for p in c["pairs"]]
    return eval_judge(gold, pairs, llm, decider)


def run_e2e(convs, llm, decider) -> dict:
    msgs, gold, preds, rows, failed = [], [], [], [], []
    for conv_id, c in convs.items():
        p, f = run_classify(c["msgs"], llm, decider, context=c["context"])
        preds += p
        failed += f
        msgs += c["msgs"]
        gold += c["gold"]
        rows += eval_e2e(p, c["pairs"], llm, decider)["rows"]  # 충돌 비교는 팀 안에서만
    failed_ids = {f["session"] for f in failed}
    acc, _ = score_classify([m for m in msgs if m["conversationId"] not in failed_ids], gold, preds)
    acc["incomplete_sessions"] = len(failed)
    outcomes = [(should_alert(r["want"]), bool(r["alerts"])) for r in rows]
    return {"classify": acc, "e2e": alert_rates(outcomes), "pair_rows": rows, "failed_sessions": failed}


def main() -> int:
    load_env()
    what = sys.argv[1] if len(sys.argv) > 1 else "judge"
    split = sys.argv[sys.argv.index("--split") + 1] if "--split" in sys.argv else "dev"
    rule = "--rule" in sys.argv
    if what not in ("judge", "e2e"):
        print(__doc__, file=sys.stderr)
        return 2
    convs = load(split)
    llm = decider = None
    if not rule:
        try:
            llm = from_env()
        except LLMNotConfigured as e:
            print(e, file=sys.stderr)
            return 1
        decider = decider_from_env()
    elif what == "e2e":
        print("전체 흐름 평가는 외부 AI 가 필요합니다.", file=sys.stderr)
        return 1
    print(f"대화 {len(convs)}개 ({split}), 판정: {'Decisions' if decider else ('chat 모델' if llm else '규칙')}",
          file=sys.stderr)
    res = run_judge(convs, llm, decider) if what == "judge" else run_e2e(convs, llm, decider)
    print(json.dumps({k: v for k, v in res.items() if not k.endswith("rows")}, ensure_ascii=False, indent=2))
    print(f"저장: {save_result(f'synth-{what}-{split}' + ('-rule' if rule else ''), res)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
