"""평가 공통: 실패를 행으로 남기고 끝까지 도는 분류·충돌 호출, 경고 감지율, 결과 저장.

실제 AI 는 낮은 확신도·한도 초과·응답 오류로 검사를 끝내지 못할 수 있다. 평가는 그 항목을 '미완료'로 세고 다음으로 간다.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from syncup_ai import conflict
from syncup_ai.classify import classify_indexed

RESULTS = Path(__file__).resolve().parent / "results"  # 커밋하지 않는다 (ai/.gitignore)


def should_alert(want: str) -> bool:
    """정답 판정이 경고 대상인가 (conflict 와 같은 기준, config.CONFLICT_ON_CHANGE)."""
    return want in conflict.alert_judgements()


def classify_positions(request: dict, llm, decider) -> tuple[list[tuple[int, dict]], str | None]:
    """(발화 위치, 카드) 목록과 실패 이유. 분류가 실패하면 ([], 이유)."""
    try:
        return classify_indexed(request, llm, decider), None
    except Exception as error:  # 실제 수집기도 실패한 묶음을 남기고 다음 묶음을 처리한다
        return [], f"{type(error).__name__}: {error}"


def judge(new: dict, existing: list[dict], llm, decider) -> tuple[list[dict], list[dict], str | None]:
    """새 결정 하나의 (판정 목록, 경고 목록, 실패 이유). 실패하면 ([], [], failureReason)."""
    result = conflict.handle_request({"newCards": [new], "existing": existing}, llm, decider)
    if not result["ok"]:
        return [], [], result["failureReason"]
    return result["results"][0]["judgements"], result["conflicts"], None


def alert_rates(outcomes: list[tuple[bool, bool]]) -> dict:
    """[(경고해야 함, 경고함)] → 감지율(목표 0.8 이상, 2차 회의)·오경보율."""
    tp = sum(should and alerted for should, alerted in outcomes)
    fn = sum(should and not alerted for should, alerted in outcomes)
    fp = sum(alerted and not should for should, alerted in outcomes)
    tn = sum(not should and not alerted for should, alerted in outcomes)
    return {"detection_rate": round(tp / max(tp + fn, 1), 3), "false_alarm_rate": round(fp / max(fp + tn, 1), 3)}


def save_result(name: str, result: dict) -> Path:
    """eval/results/<name>-<월일-시분>.json 에 저장하고 경로를 돌려준다."""
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"{name}-{datetime.now():%m%d-%H%M}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return out
