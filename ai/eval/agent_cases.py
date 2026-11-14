"""SynTitan Ready for Agent 케이스로 충돌 판정을 잰다 (판정 실력 A, 2차 최종 회의 11장).

  python3 -m eval.agent_cases split                      # 개발용 / 최종 측정용 개수
  python3 -m eval.agent_cases run --split dev --tag v1   # 판정 실행 (외부 AI 필요)
  python3 -m eval.agent_cases run --split dev --tag v1 --judge decisions   # 서버의 1순위인 Decisions 로
  python3 -m eval.agent_cases run --split final --tag v2 # 최종 측정은 마지막에 한 번만

1) 입력: eval/syntitan/package/agent_questions.csv (케이스 133개 + 다른 표현 31개). 정답: eval/syntitan/labels.csv
   패키지에는 정답이 없어서 우리 규칙 문서 기준으로 정했다. review=검수 는 사람이 다시 볼 것.
2) 나누기: 정답 종류마다 번호 순으로 번갈아 개발용·최종 측정용. 다른 표현(C-012-1)은 원래 케이스를 따라간다.
3) 판정: 기본은 서비스의 chat 경로와 같은 prompts/conflict_system.md 로 묻는다. --judge decisions 면 서버가 먼저 쓰는
   Decisions 질문(decide.JUDGE_QUESTION)으로 묻는다. 케이스가 카드가 아니라 상황 글이라 서버 경로 전체(후보 고르기, 독립 검토)는
   거치지 않는다. SynTitan 안내대로 전후 비교 동안 모델·설정은 그대로 두고 자료만 바꾼다.
4) 채점: 화면에 보이는 알림(없음·변경·충돌·확인 필요)으로 맞았는지 센다. 확신도 0.6 미만은 판정과 상관없이 확인 필요.
   정답이 같음·무관·비교 없음이면 알림 없음, 변경은 CONFLICT_ON_CHANGE 에 따라 변경 알림.
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter, defaultdict
from pathlib import Path

from syncup_ai import config
from syncup_ai.config import LOW_CONFIDENCE, load_env
from syncup_ai.decide import JUDGE_CHOICES, JUDGE_QUESTION, _conf
from syncup_ai.llm import LLMNotConfigured, choice_q, decider_from_env, from_env

from .scoring import save_result

PACKAGE = Path(__file__).resolve().parent / "syntitan" / "package"
LABELS = Path(__file__).resolve().parent / "syntitan" / "labels.csv"
JUDGEMENTS = ("같음", "변경", "충돌", "무관")
# 정답 판정 → 화면 알림. 변경은 CONFLICT_ON_CHANGE 가 켜져 있을 때만 알림
EXPECTED_ALERT = {
    "충돌": "충돌",
    "변경": "변경" if config.CONFLICT_ON_CHANGE else "없음",
    "확인 필요": "확인 필요",
    "같음": "없음",
    "무관": "없음",
    "비교 없음": "없음",
}
ASK = ('\n\n위 상황의 새 결정을 기존 결정과 비교해 판정하세요. 결정이 아니거나 비교할 기존 결정이 없으면 무관입니다.\n'
       '{"results": [{"id": "case", "judgement": "같음|변경|충돌|무관", "reason": "...", "confidence": 0.0~1.0}]} '
       'JSON 하나로만 답하세요.')


def _read(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _parent(case_id: str) -> str:
    return "-".join(case_id.split("-")[:2])


def splits() -> dict[str, str]:
    """케이스 ID → "dev" | "final". 정답 종류마다 번호 순으로 번갈아 나눠 충돌·변경 개수가 한쪽에 몰리지 않게 한다."""
    by_expected = defaultdict(list)
    for row in _read(LABELS):
        by_expected[row["expected"]].append(row["case_id"])
    out = {}
    for ids in by_expected.values():
        for i, case_id in enumerate(sorted(ids)):
            out[case_id] = "dev" if i % 2 == 0 else "final"
    return out


def inputs(split: str) -> list[dict]:
    labels = {r["case_id"]: r for r in _read(LABELS)}
    which = splits()
    rows = []
    for q in _read(PACKAGE / "agent_questions.csv"):
        parent = _parent(q["case_id"])
        if which[parent] == split:
            label = labels[parent]
            rows.append({"case_id": q["case_id"], "input": q["input"], "expected": label["expected"],
                         "review": label["review"]})
    return rows


def shown_alert(answer: dict | None) -> str:
    """판정 결과가 화면에서 어떤 알림이 되는지."""
    if not answer or answer.get("judgement") not in JUDGEMENTS:
        return "확인 필요"  # 답이 없거나 형식이 틀리면 서비스도 검사 미완료로 남긴다
    try:
        confidence = float(answer.get("confidence"))
    except (TypeError, ValueError):
        return "확인 필요"
    if confidence < LOW_CONFIDENCE:
        return "확인 필요"
    return EXPECTED_ALERT[answer["judgement"]]


def _ask(llm, text: str) -> dict | None:
    system = (config.PROMPTS / "conflict_system.md").read_text(encoding="utf-8")
    reply = llm.chat_json(system, text + ASK)
    results = reply.get("results") if isinstance(reply, dict) else None
    return results[0] if isinstance(results, list) and results and isinstance(results[0], dict) else None


def _ask_decisions(decider, text: str) -> dict | None:
    """서버의 1순위 경로와 같은 Decisions 판정 질문·보기로 묻는다 (decide.judge_pairs). 이유 글은 없다."""
    question = choice_q("case", JUDGE_QUESTION.format(name="case"), JUDGE_CHOICES)
    answer = decider.decide(text, [question]).get("case")
    if not answer or answer.get("choice") not in JUDGE_CHOICES:
        return None
    return {"id": "case", "judgement": answer["choice"], "confidence": _conf(answer)}


def run(split: str, tag: str, judge: str = "chat") -> dict:
    """judge: chat (conflict_system.md 프롬프트) | decisions (서버가 먼저 쓰는 Decisions 질문)"""
    load_env()
    try:
        llm = from_env()
    except LLMNotConfigured as e:
        sys.exit(f"외부 AI 설정이 없습니다: {e}")
    decider = decider_from_env() if judge == "decisions" else None
    if judge == "decisions" and decider is None:
        sys.exit("Decisions 설정이 없습니다 (OPENAI_API_KEY).")
    rows = []
    for item in inputs(split):
        try:
            if decider is not None:
                answer = _ask_decisions(decider, item["input"])
            else:
                answer = _ask(llm, item["input"])
        except Exception as e:  # 한 건 실패로 전체를 멈추지 않는다
            answer = None
            print(f"{item['case_id']} 실패: {e}", file=sys.stderr)
        want = EXPECTED_ALERT[item["expected"]]
        got = shown_alert(answer)
        rows.append({**item, "answer": answer, "want": want, "got": got, "ok": want == got})
    return {**_summary(split, tag, rows), "judge": judge}


def _summary(split: str, tag: str, rows: list[dict]) -> dict:
    confusion = Counter((r["want"], r["got"]) for r in rows)
    reviewed = [r for r in rows if not r["review"]]
    result = {
        "tag": tag, "split": split, "inputs": len(rows),
        "alert_accuracy": round(sum(r["ok"] for r in rows) / max(len(rows), 1), 3),
        "alert_accuracy_without_review": round(sum(r["ok"] for r in reviewed) / max(len(reviewed), 1), 3),
        "needs_check_rate": round(sum(r["got"] == "확인 필요" for r in rows) / max(len(rows), 1), 3),
        "missed_conflicts": sum(r["want"] == "충돌" and r["got"] != "충돌" for r in rows),
        "false_alerts": sum(r["want"] == "없음" and r["got"] in ("충돌", "변경") for r in rows),
        "confusion": {f"{w} → {g}": n for (w, g), n in sorted(confusion.items())},
        "rows": rows,
    }
    print(f"[{tag} · {split}] {len(rows)}건 알림 정답률 {result['alert_accuracy']} "
          f"(검수 필요 제외 {result['alert_accuracy_without_review']}), 확인 필요 비율 {result['needs_check_rate']}, "
          f"놓친 충돌 {result['missed_conflicts']}, 불필요한 알림 {result['false_alerts']}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("split", "run"))
    parser.add_argument("--split", choices=("dev", "final"), default="dev")
    parser.add_argument("--tag", default="v1")
    parser.add_argument("--judge", choices=("chat", "decisions"), default="chat")
    args = parser.parse_args()
    if args.command == "split":
        for split in ("dev", "final"):
            rows = inputs(split)
            cases = {_parent(r["case_id"]) for r in rows}
            kinds = Counter(r["expected"] for r in rows)
            print(f"{split}: 케이스 {len(cases)}개, 입력 {len(rows)}개, 정답 {dict(kinds)}")
        return
    result = run(args.split, args.tag, args.judge)
    print(save_result(f"agent-{args.tag}-{args.judge}-{args.split}", result))


if __name__ == "__main__":
    main()
