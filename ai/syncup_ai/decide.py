"""Decisions API 로 라벨 다시 매기기 + 충돌 판정.

chat 모델이 나눈 문장(카드)마다 관련성·표시·소주제·변경을 Decisions 에 물어 덮어쓰고,
선택 확률을 확신도(confidence)로 쓴다 → "확인 필요"(0.6 미만) 배지가 실제 확률에 맞춰진다.
"""
from __future__ import annotations

from . import config
from .llm import Decider, choice_q, predicate_q
from .schema import SUBTOPICS

TAG_CHOICES = {
    "decision": "팀이 정한 내용 (요청·질문 속에 전제로 들어 있는 결정 포함). 사용자 발화만",
    "todo": "누군가 해야 할 팀 작업·담당 지정. 사용자 발화만",
    "research": "알게 된 사실·자료·외부 조건·팀 상황 정보",
    "none": "제안·질문·AI에게 하는 요청·AI의 추천·예시·코드·반복 요약",
}
SUBTOPIC_DESC = {
    "주제·목표": "주제, 목표, 타깃, 서비스명, 범위, 방향",
    "자료 조사": "조사 활동 자체: 논문·기사·통계·사례·비교 결과",
    "작업·결과물": "실제로 만드는 것: 코드, 기능, 디자인, 기술 선택, 보고서 본문",
    "역할·일정": "담당, 팀 내부 마감, 회의 시간",
    "과제 조건·피드백": "교수님·주최 측 조건, 평가·심사 기준, 받은 피드백",
    "발표·제출": "발표자, 발표 자료, 제출 방법과 기한",
    "기타": "위에 맞지 않는 팀 관련 내용",
}
JUDGE_CHOICES = {
    "같음": "같은 대상에 같은 값 (표현만 다르거나 범위만 더 구체해짐)",
    "변경": "같은 사람이 자기 결정을 고치거나, 팀 합의·팀 의견으로 바꿨다고 밝힘",
    "충돌": "같은 대상에 양립할 수 없는 값을 다른 사람이 따로 정함 (팀원끼리 어긋남)",
    "무관": "대상이 다르거나 둘 다 성립할 수 있음",
}


def _conf(answer: dict | None) -> float | None:
    if not answer:
        return None
    if isinstance(answer.get("confidence"), (int, float)):
        return float(answer["confidence"])
    probs = [p.get("probability", 0) for p in answer.get("probabilities", []) if isinstance(p, dict)]
    return max(probs) if probs else None


def relabel(cards: list[dict], conversation: str, decider: Decider, enabled: list[str] | None = None) -> list[dict]:
    """관련 카드들의 라벨을 Decisions 답으로 덮어쓴 '원시 카드'(normalize 전 모양) 목록. 실패하면 예외."""
    criteria = (config.PROMPTS / "decisions_criteria.md").read_text(encoding="utf-8")
    subtopics = [s for s in SUBTOPICS if not enabled or s in enabled]
    units, questions = [], []
    for k, c in enumerate(cards, start=1):
        if c.get("relevance") != "related":
            continue
        u = f"u{k}"
        units.append(f"{u} (발화 {c['_msg']}): {c['sentence']}")
        questions += [
            choice_q(f"{u}_rel", f"{u} 문장은 팀 프로젝트와 관련 있는가?",
                     {"related": "팀 프로젝트 관련", "personal": "팀과 무관한 개인 내용"}),
            choice_q(f"{u}_tag", f"{u} 문장의 표시는?", TAG_CHOICES),
            choice_q(f"{u}_sub", f"{u} 문장의 소주제는?", {s: SUBTOPIC_DESC[s] for s in subtopics}),
            predicate_q(f"{u}_chg", f"{u} 문장이 결정이라면, 기존 팀 결정을 바꾸거나 기존 결정과 다른 값을 정하는가?"),
        ]
    if not questions:
        return cards
    answers = decider.decide(f"{criteria}\n\n{conversation}\n\n# 판정할 문장\n" + "\n".join(units), questions)

    out = []
    for k, c in enumerate(cards, start=1):
        u = f"u{k}"
        rel, tag, sub, chg = (answers.get(f"{u}_{s}") for s in ("rel", "tag", "sub", "chg"))
        if c.get("relevance") != "related" or not rel:
            out.append(c)
            continue
        if rel.get("choice") == "personal":
            out.append({"_msg": c["_msg"], "relevance": "personal", "masked": c.get("masked", False),
                        "confidence": _conf(rel) or 0.5})
            continue
        if not tag:
            out.append(c)
            continue
        c = dict(c)
        c["tag"] = tag.get("choice", c.get("tag"))
        if sub and sub.get("choice"):
            c["subtopic"] = sub["choice"]
        if chg is not None and isinstance(chg.get("probability"), (int, float)):
            c["is_change"] = chg["probability"] >= 0.5
        confs = [x for x in (_conf(rel), _conf(tag)) if x is not None]
        if confs:
            c["confidence"] = min(confs)
        c["_labeled_by"] = "decisions"
        out.append(c)
    return out


def judge_pairs(new: dict, candidates: list[dict], decider: Decider) -> list[dict]:
    """새 결정 ↔ 기존 결정 후보들 → [{id, judgement, reason, confidence}]"""
    def line(c):
        return f"[{c.get('topic_key')}] {c.get('content')} — 원문: \"{c.get('sentence')}\" (결정자 {c.get('owner') or '미상'}, {c.get('source', '')})"

    text = "# 새 결정\n" + line(new) + "\n\n# 기존 결정\n" + "\n".join(f"e{i}: {line(c)}" for i, c in enumerate(candidates, 1))
    qs = [choice_q(f"e{i}", f"새 결정과 기존 결정 e{i}의 관계는?", JUDGE_CHOICES) for i in range(1, len(candidates) + 1)]
    answers = decider.decide(text, qs)
    out = []
    for i, c in enumerate(candidates, 1):
        a = answers.get(f"e{i}")
        if not a or a.get("choice") not in JUDGE_CHOICES:
            raise ValueError(f"판정 답 없음: e{i}")
        j = a["choice"]
        reason = {
            "같음": f"기존 결정 '{c.get('content')}'과(와) 같은 내용",
            "변경": f"기존 결정 '{c.get('content')}'을(를) '{new.get('content')}'(으)로 바꿈",
            "충돌": f"{c.get('owner') or '기존'}의 결정 '{c.get('content')}'과(와) {new.get('owner') or '새'} 결정 '{new.get('content')}'이(가) 어긋남",
            "무관": "대상이 다름",
        }[j]
        out.append({"id": c.get("id"), "judgement": j, "reason": reason, "confidence": round(_conf(a) or 0.5, 2)})
    return out
