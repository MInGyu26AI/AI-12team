"""결정·커밋 어긋남 판정: 레포에 올라온 커밋 ↔ 팀 상태 파일의 현재 결정 (2차 최종 회의 10장 선택 기능).

1) 입력: 커밋 하나 {sha, message, author, files} 와 syncup.json (team_state.build_state 결과).
2) 후보: 현재 결정 전부 (최대 COMMIT_MAX_DECISIONS). 결정은 한국어, 커밋은 영어 경로일 때가 많아 낱말로 거르지 않는다.
3) 판정: chat 모델에 prompts/commit_system.md 로 묻는다. 결정마다 같음·충돌·무관과 확신도.
4) 충돌만 알림으로 돌려준다. 확신도 0.6 미만은 '확인 필요'. 커밋 글은 Public 레포에 있어도 외부로 보내기 전에 한 번 더 가린다.
"""
from __future__ import annotations

import json

from . import config
from .config import LOW_CONFIDENCE
from .llm import LLM
from .mask import mask_text


def current_decisions(state: dict) -> list[dict]:
    """syncup.json 의 현재 결정을 [{id, topic_key, content, owner}] 로 (팀 상태 파일 순서)."""
    out = []
    for topic in state.get("decisions") or []:
        for d in topic.get("current") or []:
            out.append({"id": f"d{len(out) + 1}", "topic_key": topic["topic_key"], "content": d.get("content"),
                        "owner": d.get("owner")})
    return out[:config.COMMIT_MAX_DECISIONS]


def _commit_text(commit: dict) -> str:
    files = list(commit.get("files") or [])[:config.COMMIT_MAX_FILES]
    lines = [f"메시지: {commit.get('message') or ''}", f"작성자: {commit.get('author') or '미상'}", "바뀐 파일:"]
    lines += [f"- {f}" for f in files] or ["(없음)"]
    return "\n".join(lines)


def _confidence(v) -> float:
    try:
        return min(max(float(v), 0.0), 1.0)
    except (TypeError, ValueError):
        return 0.0


def check_commit(commit: dict, state: dict, llm: LLM) -> list[dict]:
    """커밋 하나와 어긋나는 결정 목록. [{commit, topic_key, decision, owner, judgement, reason, confidence}]"""
    decisions = current_decisions(state)
    if not decisions:
        return []
    system = (config.PROMPTS / "commit_system.md").read_text(encoding="utf-8")
    user = (
        "# 커밋\n" + _commit_text(commit)
        + "\n\n# 팀의 현재 결정\n" + "\n".join(json.dumps(d, ensure_ascii=False) for d in decisions)
        + '\n\n결정마다 판정해 {"results": [...]} JSON 하나로만 답하세요.'
    )
    reply = llm.chat_json(system, mask_text(user))
    by_id = {str(r.get("id")): r for r in reply.get("results", []) if isinstance(r, dict)}
    alerts = []
    for d in decisions:
        r = by_id.get(d["id"])
        if not r or r.get("judgement") != "충돌":
            continue
        confidence = _confidence(r.get("confidence"))
        alerts.append({
            "commit": commit.get("sha"), "topic_key": d["topic_key"], "decision": d["content"], "owner": d["owner"],
            "judgement": "충돌" if confidence >= LOW_CONFIDENCE else "확인 필요",
            "reason": mask_text(str(r.get("reason") or "")), "confidence": round(confidence, 2),
        })
    return alerts


def handle_request(request: dict, llm: LLM | None) -> dict:
    """{"commit": {...}, "state": syncup.json} → {"ok", "alerts"}"""
    if llm is None:
        return {"ok": False, "error": "커밋 판정에는 외부 AI 설정이 필요합니다."}
    commit = request.get("commit")
    if not isinstance(commit, dict) or not commit.get("sha"):
        return {"ok": False, "error": "커밋 정보(sha)를 확인하세요."}
    try:
        return {"ok": True, "alerts": check_commit(commit, request.get("state") or {}, llm)}
    except Exception as e:  # 커밋 판정 실패는 승인·저장 흐름에 영향을 주지 않는다
        return {"ok": False, "error": f"커밋 판정 실패: {e}"}
