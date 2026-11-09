"""Decisions API 로 라벨 다시 매기기 + 충돌 판정.

chat 모델이 나눈 문장(카드)마다 관련성·표시·소주제·변경을 Decisions 에 물어 덮어쓰고,
API의 별도 confidence를 우선 사용해 "확인 필요"(0.6 미만)를 표시한다.
"""
from __future__ import annotations

from . import config
from .llm import Decider, DecisionsResponseError, choice_q, predicate_q
from .schema import SUBTOPICS
from .mask import mask_text

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
    "같음": "같은 대상·항목·범위·시점에서 최종 채택 값이 같다. 변경 이력 유무와 결정자 차이는 이 경우 관계를 바꾸지 않는다.",
    "변경": "같은 대상의 최종 값이 서로 다르고, 같은 결정자의 수정이거나 명시적인 팀 합의로 현재 비교하는 기존 값을 바꾼다.",
    "충돌": "같은 대상의 최종 값이 양립 불가능하고, 다른 결정자가 합의 없이 따로 정했다.",
    "무관": "대상·항목·적용 범위·시점이 다르거나, 최종 값은 다르지만 두 결정이 함께 성립한다. 같은 대상의 동일 값은 같음이다.",
}
# 기존 결정 하나({name})마다 묻는 판정 질문. 실제 API로 검증한 문장이라 바꾸면 충돌 판정 정확도를 다시 재야 한다.
JUDGE_QUESTION = (
    "새 결정과 지금 비교하는 기존 결정 {name} 사이의 관계를 아래 순서로 판정한다. "
    "1. 결정 대상·항목이 다르거나 적용 범위·시점이 전혀 겹치지 않으면 무관이다. "
    "2. 같은 대상이면 두 결정이 최종적으로 채택한 값을 비교한다. 최종 값이 같으면 같음이다. "
    "새 문장에 A에서 B로 바꾼다는 이력이 있어도 기존 결정의 값이 이미 B이면 같음이다. "
    "3. 최종 값이 다를 때만 변경 또는 충돌을 판정한다. 같은 결정자의 수정이나 명시적 팀 합의는 변경, "
    "다른 결정자가 합의 없이 양립 불가능한 값을 정하면 충돌이다. "
    "현재 비교하는 기존 결정이 아닌 다른 과거 결정의 변경 이력만으로 변경을 선택하지 않는다. "
    "표현이 다른 날짜와 시각은 의미를 비교하되 입력에 없는 시간대, 날짜, 대상, 합의는 추측하지 않는다. "
    "기존 범위를 부정하지 않는 구체화는 같음이며, 제외·대체하는 축소는 수정이다. "
    "독립 범위가 일부만 겹치면 교집합의 값이 모순일 때 변경/충돌, 모순이 없으면 무관이다."
)
CHANGE_THRESHOLD = 0.5  # 변경 predicate 확률이 이 값 이상이면 is_change
UNKNOWN_OWNERS = ("미상", "사용자", "unknown")  # 결정자를 모를 때 카드에 들어오는 자리표시자


def _conf(answer: dict | None) -> float | None:
    if not answer:
        return None
    if type(answer.get("confidence")) in (int, float):
        return float(answer["confidence"])
    probs = [p.get("probability", 0) for p in answer.get("probabilities", []) if isinstance(p, dict)]
    return max(probs) if probs else None


def _label_questions(unit: str, subtopics: list[str]) -> list[dict]:
    return [
        choice_q(f"{unit}_rel", f"{unit} 문장은 팀 프로젝트와 관련 있는가?",
                 {"related": "팀 프로젝트 관련", "personal": "팀과 무관한 개인 내용"}),
        choice_q(f"{unit}_tag", f"{unit} 문장의 표시는?", TAG_CHOICES),
        choice_q(f"{unit}_sub", f"{unit} 문장의 소주제는?", {s: SUBTOPIC_DESC[s] for s in subtopics}),
        predicate_q(f"{unit}_chg", f"{unit} 문장이 결정이라면, 기존 팀 결정을 바꾸거나 기존 결정과 다른 값을 정하는가?"),
    ]


def relabel(cards: list[dict], conversation: str, decider: Decider, enabled: list[str] | None = None) -> list[dict]:
    """관련 카드들의 라벨을 Decisions 답으로 덮어쓴 '원시 카드'(normalize 전 모양) 목록. 실패하면 예외."""
    criteria = (config.PROMPTS / "decisions_criteria.md").read_text(encoding="utf-8")
    # 꺼 둔 소주제 내용은 기타로 가야 하므로 기타는 꺼 두었어도 고를 수 있게 둔다 (schema 도 기타로 바꾼다)
    subtopics = [s for s in SUBTOPICS if not enabled or s in enabled or s == "기타"]
    units, questions = [], []
    for k, c in enumerate(cards, start=1):
        if c.get("relevance") == "related":
            units.append(f"u{k} (발화 {c['_msg']}): {c['sentence']}")
            questions += _label_questions(f"u{k}", subtopics)
    if not questions:
        return cards
    answers = decider.decide(mask_text(f"{criteria}\n\n{conversation}\n\n# 판정할 문장\n" + "\n".join(units)), questions)
    return [_apply_labels(c, answers, f"u{k}") if c.get("relevance") == "related" else c
            for k, c in enumerate(cards, start=1)]


def _answer(answers: dict[str, dict], name: str, field: str) -> dict:
    """질문 하나의 답. 없거나 값(field)이 빠졌으면 전체 실패 (RESPONSE_VALIDATION.md: 누락은 chat 라벨로 숨기지 않는다)."""
    answer = answers.get(name)
    if not isinstance(answer, dict) or field not in answer:
        raise DecisionsResponseError("Decisions 답이 누락되었습니다.")
    return answer


def _apply_labels(card: dict, answers: dict[str, dict], unit: str) -> dict:
    """Decisions 답으로 카드 하나의 라벨을 덮어쓴다."""
    rel, tag, sub = (_answer(answers, f"{unit}_{s}", "choice") for s in ("rel", "tag", "sub"))
    chg = _answer(answers, f"{unit}_chg", "probability")
    if rel["choice"] == "personal":
        confidence = _conf(rel)  # 0.0 도 유효한 값이다
        if confidence is None:
            raise DecisionsResponseError("Decisions 답에 확신도 근거가 없습니다.")
        return {"_msg": card["_msg"], "relevance": "personal", "masked": card.get("masked", False),
                "confidence": confidence}
    confs = [_conf(rel), _conf(tag)]
    if None in confs:
        raise DecisionsResponseError("Decisions 답에 확신도 근거가 없습니다.")
    card = dict(card)
    card["tag"] = tag["choice"]
    card["subtopic"] = sub["choice"]
    card["is_change"] = chg["probability"] >= CHANGE_THRESHOLD
    card["confidence"] = min(confs)
    card["_labeled_by"] = "decisions"
    return card


def judgement_reason(judgement: str, new: dict, old: dict) -> str:
    """화면에 보일 판정 이유의 기본 문구 (판정마다 고정)."""
    return {
        "같음": f"기존 결정 '{old.get('content')}'과(와) 같은 내용",
        "변경": f"기존 결정 '{old.get('content')}'을(를) '{new.get('content')}'(으)로 바꿈",
        "충돌": f"{old.get('owner') or '기존'}의 결정 '{old.get('content')}'과(와) {new.get('owner') or '새'} 결정 '{new.get('content')}'이(가) 어긋남",
        "무관": "대상·적용 범위가 다르거나 두 결정이 양립 가능함",
    }[judgement]


def _owner(card: dict) -> str | None:
    """알 수 있는 결정자 이름(앞뒤 공백 제거). 비었거나 자리표시자면 None."""
    owner = card.get("owner")
    if not isinstance(owner, str) or owner.strip() in ("", *UNKNOWN_OWNERS):
        return None
    return owner.strip()


def _owner_evidence(new: dict, old: dict) -> str:
    old_owner, new_owner = _owner(old), _owner(new)
    if old_owner and new_owner:
        relation = "동일" if old_owner == new_owner else "다름"
    else:
        relation = "미상"
    return (f'\n\n# 현재 쌍의 결정자 정보\n기존 결정자: {old_owner or "미상"}'
            f'\n새 결정자: {new_owner or "미상"}\n두 결정자: {relation}')


def _decision_line(c: dict) -> str:
    # 검색용 주제 이름이 실제 결정 대상을 덮어쓰지 않게 판정 입력에서는 제외한다.
    return f"{c.get('content')} — 원문: \"{c.get('sentence')}\" (결정자 {c.get('owner') or '미상'}, {c.get('source', '')}) 이유: {c.get('reason') or ''}"


def judge_pairs(new: dict, candidates: list[dict], decider: Decider, *, with_owner_evidence: bool = False) -> list[dict]:
    """새 결정 ↔ 기존 결정 후보들 → [{id, judgement, reason, confidence}]"""
    text = ("# 새 결정\n" + _decision_line(new) + "\n\n# 기존 결정\n"
            + "\n".join(f"e{i}: {_decision_line(c)}" for i, c in enumerate(candidates, 1)))
    if with_owner_evidence:
        if len(candidates) != 1:
            raise ValueError('보완 검토는 한 쌍씩 수행해야 합니다.')
        text += _owner_evidence(new, candidates[0])
    questions = [choice_q(f"e{i}", JUDGE_QUESTION.format(name=f"e{i}"), JUDGE_CHOICES)
                 for i in range(1, len(candidates) + 1)]
    answers = decider.decide(mask_text(text), questions)
    out = []
    for i, c in enumerate(candidates, 1):
        a = answers.get(f"e{i}")
        if not a or a.get("choice") not in JUDGE_CHOICES:
            raise ValueError(f"판정 답 없음: e{i}")
        confidence = _conf(a)
        out.append({"id": c.get("id"), "judgement": a["choice"], "reason": judgement_reason(a["choice"], new, c),
                    "confidence": confidence if confidence is not None else 0.0})
    return out
