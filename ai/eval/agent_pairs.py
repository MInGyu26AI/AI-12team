"""SynTitan 2차 케이스를 카드 쌍으로 옮긴 것(eval/syntitan/pairs_v2.csv)을 서버와 같은 경로로 판정한다.

  python3 -m eval.syntitan.make_pairs_v2       # 카드 쌍 만들기 (외부 AI 없음)
  python3 -m eval.agent_pairs run --tag v2     # 판정 (외부 AI 필요)

1) 쌍마다 기존 결정 카드 1장과 새 결정 카드 1장을 만든다. 필드는 서버가 판정에 쓰는 것만 (content, sentence, owner, source, is_change).
2) 판정: 서버와 같은 conflict.check_new_decision (Decisions → 확신도가 낮으면 chat 모델과 Decisions 의 독립 검토). 규칙 대체는 끈다.
   독립 검토 뒤에도 확신도가 낮으면 서버처럼 '확인 필요'로 센다.
3) 채점: eval.agent_cases 와 같다 (화면 알림 없음·변경·충돌·확인 필요 기준).
   이 데이터는 최종 측정(11/14) 뒤에 만든 추가 검증용이라 프롬프트를 고치는 데 쓰지 않는다.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from syncup_ai.config import load_env
from syncup_ai.conflict import LowConfidenceError, check_new_decision
from syncup_ai.llm import LLMNotConfigured, decider_from_env, from_env

from .agent_cases import EXPECTED_ALERT, _summary
from .scoring import save_result

PAIRS = Path(__file__).resolve().parent / "syntitan" / "pairs_v2.csv"
ALERT = {"충돌": "충돌", "변경": "변경"}


def _card(row: dict, side: str, card_id: str) -> dict:
    return {
        "id": card_id, "relevance": "related", "tag": "decision", "status": "approved",
        "content": row[f"{side}_content"], "sentence": row[f"{side}_sentence"],
        "owner": row[f"{side}_owner"] or None, "topic_key": row[f"{side}_topic"],
        "source": row[f"{side}_date"], "is_change": side == "new" and row["new_is_change"] == "1",
    }


def pairs() -> list[dict]:
    with PAIRS.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def judge(row: dict, llm, decider) -> tuple[str, dict]:
    """(화면 알림, 판정 기록)"""
    old, new = _card(row, "old", "old"), _card(row, "new", "new")
    try:
        judged, conflicts = check_new_decision(new, [old], llm, decider, allow_rules=False)
    except LowConfidenceError:
        return "확인 필요", {"judgement": None, "method": "low-confidence"}
    if not judged:
        return "없음", {"judgement": None, "method": "not-compared"}
    j = judged[0]
    record = {k: j.get(k) for k in ("judgement", "confidence", "method", "reviewedBy", "reason")}
    alert = ALERT.get(j["judgement"], "없음") if conflicts else "없음"
    return alert, record


def run(tag: str) -> dict:
    load_env()
    try:
        llm = from_env()
    except LLMNotConfigured as e:
        sys.exit(f"외부 AI 설정이 없습니다: {e}")
    decider = decider_from_env()
    rows = []
    for row in pairs():
        try:
            got, answer = judge(row, llm, decider)
        except Exception as e:  # 통신 실패 등은 서비스도 검사 미완료로 남긴다
            got, answer = "확인 필요", {"error": str(e)}
            print(f"{row['case_id']} 실패: {e}", file=sys.stderr)
        want = EXPECTED_ALERT[row["expected"]]
        rows.append({"case_id": row["case_id"], "expected": row["expected"], "review": row["review"],
                     "note": row["note"], "answer": answer, "want": want, "got": got, "ok": want == got})
    return {**_summary("pairs-v2", tag, rows), "judge": "server"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("run",))
    parser.add_argument("--tag", default="v2")
    args = parser.parse_args()
    result = run(args.tag)
    print(save_result(f"agent-pairs-{args.tag}", result))


if __name__ == "__main__":
    main()
