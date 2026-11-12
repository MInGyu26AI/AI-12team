"""팀 상태 파일 (syncup.json, SYNCUP.md) 만들기. 형식은 docs/team-state.md"""
import json
import re
from datetime import datetime, timedelta, timezone

from .mask import mask_text
from .schema import SUBTOPICS

KST = timezone(timedelta(hours=9))
TODO_ID = re.compile(r"(?<![A-Za-z0-9])SU-(\d+)(?![A-Za-z0-9])", re.I)
RESOLUTION_NAMES = {"keep-existing": "기존 결정 유지", "adopt-new": "새 결정 채택", "both-valid": "둘 다 유효"}


def todo_ids(cards):
    """할 일 카드에 공유된 순서대로 SU-1, SU-2 ... 를 붙인다."""
    ids = {}
    for card in cards:
        if card.get("tag") == "todo":
            ids[card["id"]] = f"SU-{len(ids) + 1}"
    return ids


def find_todo_ids(text):
    """커밋 메시지나 PR 제목에 있는 할 일 ID."""
    found = []
    for m in TODO_ID.finditer(text or ""):
        todo_id = f"SU-{int(m.group(1))}"
        if todo_id not in found:
            found.append(todo_id)
    return found


def to_kst(seconds):
    if not seconds:
        return None
    return datetime.fromtimestamp(seconds, KST).isoformat(timespec="minutes")


def clean(text):
    # 레포가 Public 이라 한 번 더 가린다
    return mask_text(text) if text else text


def owner_name(card, members):
    return clean(card.get("owner")) or members.get(card.get("approvedBy"))


def decision_item(card, members):
    return {
        "card_id": card["id"],
        "content": clean(card.get("content")),
        "reason": clean(card.get("reason")),
        "owner": owner_name(card, members),
        "decided_at": to_kst(card.get("approvedAt")),
        "state": card.get("decisionState", "active"),
    }


def conflict_item(conflict, members):
    a = conflict.get("cardA") or {}
    b = conflict.get("cardB") or {}
    item = {
        "id": conflict.get("id"),
        "topic_key": clean(conflict.get("topic_key")),
        "judgement": conflict.get("judgement"),
        "reason": clean(conflict.get("reason")),
        "existing": {"card_id": a.get("id"), "content": clean(a.get("content")), "owner": owner_name(a, members)},
        "new": {"card_id": b.get("id"), "content": clean(b.get("content")), "owner": owner_name(b, members)},
    }
    if conflict.get("resolution") == "discuss":
        item["status"] = "discuss"
    elif conflict.get("resolution"):
        item["resolution"] = conflict["resolution"]
        item["note"] = clean(conflict.get("resolutionNote") or "")
    else:
        item["status"] = "open"
    return item


def build_state(cards, conflicts=(), done=(), team=None, members=None):
    """board(history=True), conflicts(history=True), done_todos 결과로 syncup.json 내용을 만든다."""
    members = members or {}
    cards = [c for c in cards if c.get("relevance", "related") == "related" and c.get("tag") != "none"]
    ids = todo_ids(cards)

    topics = {}
    for card in cards:
        if card.get("tag") != "decision":
            continue
        key = clean(card.get("topic_key")) or "(주제 없음)"
        if key not in topics:
            topics[key] = {"topic_key": key, "subtopic": card.get("subtopic") or "기타", "current": [], "history": []}
        if card.get("decisionState", "active") in ("active", "review"):
            topics[key]["current"].insert(0, decision_item(card, members))  # 최신이 앞
        else:
            topics[key]["history"].insert(0, decision_item(card, members))
    for topic in topics.values():
        in_review = any(d["state"] == "review" for d in topic["current"])
        topic["status"] = "review" if in_review else "settled"
    decisions = sorted(topics.values(), key=lambda t: (SUBTOPICS.index(t["subtopic"]), t["topic_key"]))

    todos = []
    research = []
    for card in cards:
        if card.get("tag") == "todo":
            todos.append({"id": ids[card["id"]], "card_id": card["id"], "content": clean(card.get("content")),
                          "owner": clean(card.get("owner")), "due": card.get("due"),
                          "topic_key": clean(card.get("topic_key")), "done": card["id"] in done})
        elif card.get("tag") == "research":
            research.append({"card_id": card["id"], "content": clean(card.get("content")),
                             "topic_key": clean(card.get("topic_key")), "subtopic": card.get("subtopic"),
                             "added_at": to_kst(card.get("approvedAt"))})

    open_conflicts = []
    resolved = []
    for conflict in conflicts:
        if conflict.get("resolution") == "obsolete":
            continue
        item = conflict_item(conflict, members)
        if "status" in item:
            open_conflicts.append(item)
        else:
            resolved.append(item)

    team = {k: v for k, v in (team or {}).items() if k in ("name", "goal", "scope", "rules", "repo") and v}
    approved_times = [c["approvedAt"] for c in cards if c.get("approvedAt")]
    return {
        "syncup_version": 1,
        "team": team,
        "updated_at": to_kst(max(approved_times)) if approved_times else None,
        "summary": {
            "decisions": sum(len(t["current"]) for t in decisions),
            "open_conflicts": len(open_conflicts),
            "todos": len(todos),
            "todos_done": len([t for t in todos if t["done"]]),
            "research": len(research),
        },
        "open_conflicts": open_conflicts,
        "decisions": decisions,
        "todos": todos,
        "research": research,
        "resolved_conflicts": resolved[-10:],
    }


def dumps(state):
    return json.dumps(state, ensure_ascii=False, indent=2) + "\n"


def short_date(iso):
    if not iso:
        return ""
    return f"{int(iso[5:7])}/{int(iso[8:10])}"


def by_whom(item):
    parts = [p for p in (item.get("owner"), short_date(item.get("decided_at"))) if p]
    return " — " + ", ".join(parts) if parts else ""


def render_markdown(state):
    team = state["team"]
    s = state["summary"]
    title = "# SyncUp 팀 기록" + (f" — {team['name']}" if team.get("name") else "")
    lines = [
        title,
        "",
        "> 팀이 승인한 결정을 SyncUp이 자동으로 모은 파일입니다. 직접 고치지 마세요 (다음 승인 때 덮어씁니다).",
        f"> 기준 시각 {state['updated_at'] or '-'} · 결정 {s['decisions']} · 열린 충돌 {s['open_conflicts']}"
        f" · 할 일 {s['todos']} (완료 {s['todos_done']}) · 기계용 데이터는 `syncup.json`",
        "",
        "**코딩 AI에게**: 작업 전에 '현재 결정'을 따르세요. '확인이 필요한 결정'에 있는 주제는 바꾸기 전에 사람에게 물어보세요."
        " 할 일을 처리하면 커밋 메시지나 PR 제목에 할 일 ID(예: `SU-3`)를 넣으세요.",
        "",
    ]

    if team.get("goal") or team.get("scope") or team.get("rules"):
        lines += ["## 팀 기준", ""]
        if team.get("goal"):
            lines.append(f"- **목표**: {team['goal']}")
        if team.get("scope"):
            lines.append(f"- **범위**: {team['scope']}")
        for rule in team.get("rules") or []:
            lines.append(f"- **규칙**: {rule}")
        lines.append("")

    if state["open_conflicts"]:
        lines += ["## ⚠️ 확인이 필요한 결정", ""]
        for c in state["open_conflicts"]:
            discuss = " (팀 논의 중)" if c["status"] == "discuss" else ""
            lines.append(f"- **{c['topic_key']}** [{c['judgement'] or '충돌'}]{discuss}: "
                         f"기존 \"{c['existing']['content']}\"({c['existing']['owner'] or '?'}) ↔ "
                         f"새 \"{c['new']['content']}\"({c['new']['owner'] or '?'})")
            if c.get("reason"):
                lines.append(f"  - 이유: {c['reason']}")
        lines.append("")

    lines += ["## 현재 결정", ""]
    subtopic = None
    for topic in state["decisions"]:
        if not topic["current"]:
            continue
        if topic["subtopic"] != subtopic:
            if subtopic:
                lines.append("")
            subtopic = topic["subtopic"]
            lines += [f"### {subtopic}", ""]
        for d in topic["current"]:
            review = " _(검토 중)_" if d["state"] == "review" else ""
            lines.append(f"- **{topic['topic_key']}**: {d['content']}{by_whom(d)}{review}")
            if d.get("reason"):
                lines.append(f"  - 이유: {d['reason']}")
        for old in topic["history"][:2]:
            word = "바뀜" if old["state"] == "superseded" else "채택 안 됨"
            lines.append(f"  - ~~{old['content']}~~{by_whom(old)} ({word})")
    if subtopic is None:
        lines.append("(아직 승인된 결정이 없습니다)")
    lines.append("")

    lines += ["## 할 일", ""]
    if not state["todos"]:
        lines.append("(아직 승인된 할 일이 없습니다)")
    not_done = [t for t in state["todos"] if not t["done"]]
    done = [t for t in state["todos"] if t["done"]]
    for t in not_done + done:
        check = "x" if t["done"] else " "
        owner = f" — {t['owner']}" if t.get("owner") else ""
        due = f" · {short_date(t['due'])}까지" if t.get("due") else ""
        lines.append(f"- [{check}] `{t['id']}` {t['content']}{owner}{due}")
    lines.append("")

    if state["research"]:
        lines += ["## 조사한 내용", ""]
        for r in state["research"]:
            topic = f" ({r['topic_key']})" if r.get("topic_key") else ""
            lines.append(f"- {r['content']}{topic}")
        lines.append("")

    if state["resolved_conflicts"]:
        lines += ["## 최근 해결한 충돌", ""]
        for c in reversed(state["resolved_conflicts"]):
            note = f" — {c['note']}" if c.get("note") else ""
            lines.append(f"- **{c['topic_key']}**: {RESOLUTION_NAMES.get(c['resolution'], c['resolution'])}{note}")
        lines.append("")
    return "\n".join(lines)
