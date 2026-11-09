"""민규 님 샘플 대화·정답표로 평가.

  python3 -m eval.sheet_eval judge [--rule]   충돌 판정만 (정답 카드 사용). --rule 이면 AI 없이
  python3 -m eval.sheet_eval classify         분류 정확도 (멤버·날짜별 세션을 시간순으로 분류)
  python3 -m eval.sheet_eval e2e              분류 결과로 충돌까지 끝까지 (시연 흐름과 같음)
  결과: eval/results/sheet-*.json
  검사를 끝내지 못한 쌍·세션(낮은 확신도 등)은 incomplete 로 세고 비율 계산에서 뺀다.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from syncup_ai import conflict
from syncup_ai.config import load_env
from syncup_ai.llm import LLMNotConfigured, decider_from_env, from_env

from .scoring import alert_rates, classify_positions, judge, save_result, should_alert
from .sheets import DATA, read_table

EXCEL_EPOCH = date(1899, 12, 30)
MEMBERS = ["박지민", "이서준", "정하린", "최유나"]
CONTEXT = {
    "teamName": "싱크업",
    "projectTopic": "대학생 팀플에서 팀원마다 다른 AI를 써서 흩어지는 결정을 모아 팀 결정 기록으로 공유하고 결정 충돌을 알려주는 서비스 (해커톤)",
    "knownNames": MEMBERS,
}
TAG = {"결정": "decision", "할 일": "todo", "조사": "research", "해당 없음": "none"}
SHAREABLE = ("decision", "todo", "research")
# 표시별로 채점하는 필드 (조사의 owner_or_source 는 출처라 비교 안 함)
FIELDS_BY_TAG = {"decision": ("subtopic", "owner", "is_change"), "todo": ("subtopic", "owner", "due"),
                 "research": ("subtopic",)}
PHONE = re.compile(r"010-?\d{4}")


def _when(d: str, t: str) -> datetime:
    day = EXCEL_EPOCH + timedelta(days=int(float(d)))
    return datetime(day.year, day.month, day.day) + timedelta(seconds=round(float(t) * 86400))


def _excel_date(v: str) -> str | None:
    return (EXCEL_EPOCH + timedelta(days=int(float(v)))).isoformat() if v.strip() else None


def load():
    convs = read_table(DATA / "sample_conversations_v1.csv.xlsx")
    units = read_table(DATA / "answer_key_v1.csv.xlsx")
    pairs = read_table(DATA / "conflict_key_v1.csv.xlsx")
    msgs = []
    for r in convs:
        at = _when(r["date"], r["time"])
        msgs.append({
            "id": r["message_id"], "site": "chatgpt", "member": r["member"],
            "role": "assistant" if r["speaker"] == "ChatGPT" else "user", "text": r["text"],
            "conversationId": f"{r['member']}-{at:%m%d}", "conversationTitle": "", "url": "",
            "collectedAt": at.strftime("%Y-%m-%dT%H:%M:%S+09:00"), "_at": at,
        })
    msgs.sort(key=lambda m: m["_at"])
    gold = []
    for u in units:
        tag = next((v for k, v in TAG.items() if u["tag"].startswith(k)), None)
        gold.append({
            "unit": u["unit_id"], "message_id": u["message_id"], "text": u["text"],
            "relevance": "personal" if u["relevance"] == "개인" else "related",
            "subtopic": u["subtopic"] if u["subtopic"] not in ("", "—") else None,
            "tag": tag, "topic_key": u["topic_key"] if u["topic_key"] not in ("", "—") else None,
            "owner": u["owner_or_source"] or None, "due": _excel_date(u["due"]),
            "is_change": u["is_change"] == "1", "masked": u["masked"] == "1",
        })
    return msgs, gold, pairs


def sessions(msgs):
    """멤버·날짜별 대화 = 세션 1개 (수집 기간 종료 때 flush 해서 보낸다고 가정), 시작 시각 순."""
    by = defaultdict(list)
    for m in msgs:
        by[m["conversationId"]].append(m)
    return sorted(by.values(), key=lambda ms: ms[0]["_at"])


# ── 1) 분류 ──
def run_classify(msgs, llm, decider):
    """세션을 시간순으로 분류. 앞 세션의 결정은 '기존 팀 결정'으로 다음 요청에 들어간다 (모두 승인했다고 가정).

    (예측 [(message_id, 카드)], 분류에 실패한 세션 [{session, failure}])"""
    preds, failed = [], []  # preds: (message_id, card)
    for sess in sessions(msgs):
        decisions = [c for _, c in preds if c["relevance"] == "related" and c["tag"] == "decision"]
        ctx = {**CONTEXT, "userName": sess[0]["member"],
               "existingTopicKeys": list(dict.fromkeys(c["topic_key"] for _, c in preds if c.get("topic_key"))),
               "existingDecisions": [{"topic_key": c["topic_key"], "content": c["content"]} for c in decisions]}
        req = {"type": "classify", "version": 1, "context": ctx,
               "messages": [{k: v for k, v in m.items() if not k.startswith("_") and k != "member"} for m in sess]}
        cards, failure = classify_positions(req, llm, decider)
        if failure:
            failed.append({"session": sess[0]["conversationId"], "failure": failure})
        for pos, card in cards:
            card["id"] = f"{sess[pos]['id']}#{len(preds)}"
            card["status"] = "approved"
            preds.append((sess[pos]["id"], card))
        print(f"  분류: {sess[0]['conversationId']} ({len(sess)}발화){' 실패' if failure else ''}", file=sys.stderr)
    return preds, failed


def _same_field(field, card, gold) -> bool:
    if field == "is_change":
        return bool(card.get(field)) == gold[field]
    return (card.get(field) or None) == (gold[field] or None)


def _score_gold_unit(g, left, s, t) -> None:
    """정답 공유 후보 하나: 남은 예측 중 같은 표시를 하나 짝짓고 필드를 채점한다."""
    t["share_recall"] += 1
    t[f"recall_{g['tag']}"] += 1
    hit = next((c for c in left if c["tag"] == g["tag"]), None)
    if not hit:
        return
    left.remove(hit)
    s["share_recall"] += 1
    s[f"recall_{g['tag']}"] += 1
    for f in FIELDS_BY_TAG[g["tag"]]:
        t[f] += 1
        s[f] += _same_field(f, hit, g)


def _score_message(mid, golds, cards, from_ai, s, t) -> dict:
    G = [g for g in golds if g["relevance"] == "related" and g["tag"] in SHAREABLE]
    P = [c for c in cards if c["relevance"] == "related" and c["tag"] in SHAREABLE]
    left = list(P)
    for g in G:
        _score_gold_unit(g, left, s, t)
    t["share_precision"] += len(P)
    s["share_precision"] += len(P) - len(left)
    if from_ai:
        s["ai_false_cards"] += len(left)  # AI 답변에서 정답에 없는 공유 후보
    if golds and all(g["relevance"] == "personal" for g in golds):
        t["personal_msgs"] += 1
        s["personal_leak"] += bool(P)
    if any(g["masked"] for g in golds):
        t["masked_msgs"] += 1
        s["phone_leak"] += any(PHONE.search(c.get("sentence", "") + c.get("content", "")) for c in cards)
    return {"message_id": mid, "gold": [(g["tag"], g["topic_key"], g["text"]) for g in G],
            "pred": [(c["tag"], c.get("topic_key"), c.get("sentence")) for c in P],
            "extra": [(c["tag"], c.get("sentence")) for c in left]}


def score_classify(msgs, gold, preds):
    gold_by, pred_by = defaultdict(list), defaultdict(list)
    for g in gold:
        gold_by[g["message_id"]].append(g)
    for mid, c in preds:
        pred_by[mid].append(c)
    s, t = Counter(), Counter()
    rows = [_score_message(m["id"], gold_by[m["id"]], pred_by[m["id"]], m["role"] == "assistant", s, t) for m in msgs]
    acc = {k: round(s[k] / t[k], 3) for k in ("share_recall", "share_precision", "recall_decision", "recall_todo",
                                              "recall_research", "subtopic", "owner", "due", "is_change") if t[k]}
    acc["personal_leak"] = f"{s['personal_leak']}/{t['personal_msgs']}"
    acc["ai_false_cards"] = s["ai_false_cards"]
    acc["phone_leak"] = f"{s['phone_leak']}/{t['masked_msgs']}"
    return acc, rows


# ── 2) 충돌 판정 (정답 카드로) ──
def _gold_card(g):
    return {"id": g["unit"], "relevance": "related", "tag": g["tag"], "subtopic": g["subtopic"],
            "topic_key": g["topic_key"], "content": g["text"], "sentence": g["text"], "owner": g["owner"],
            "is_change": g["is_change"], "reason": None, "source": "", "masked": False, "confidence": 0.9}


def _units(field: str) -> list[str]:
    return [u.strip() for u in field.split("/") if u.strip()]


def eval_judge(gold, pairs, llm, decider):
    by_unit = {g["unit"]: g for g in gold}
    rows, outcomes, exact = [], [], 0
    for p in pairs:
        old = [_gold_card(by_unit[u]) for u in _units(p["old_unit"]) if u in by_unit]
        new = _gold_card(by_unit[_units(p["new_unit"])[0]])
        want = p["label"].replace("바뀜", "변경")
        judged, conflicts, failure = judge(new, old, llm, decider)
        if failure:
            got, ok = [f"미완료:{failure}"], False
        else:
            outcomes.append((should_alert(want), bool(conflicts)))
            got = [j["judgement"] for j in judged] or ["비교 안 함"]
            ok = want in got or (want == "비교 안 함" and set(got) <= {"무관", "비교 안 함"})
            exact += ok
        rows.append({"pair": p["pair_id"], "want": want, "got": got, "ok": ok, "old": p["old_text"], "new": p["new_text"],
                     "reason": [j["reason"] for j in judged]})
    return {**alert_rates(outcomes), "label_accuracy": round(exact / max(len(outcomes), 1), 3),
            "incomplete": len(pairs) - len(outcomes), "rows": rows}


# ── 3) 끝까지: 예측 카드 → 충돌 ──
def eval_e2e(preds, pairs, llm, decider):
    """팀 worker 처럼 새 결정마다 앞선 결정과 한 쌍씩 판정한다 (쌍 하나가 실패해도 나머지는 계속)."""
    existing, found, incomplete = [], [], 0  # found: (old message_id, new message_id, judgement)
    for mid, c in preds:
        if c["relevance"] != "related" or c["tag"] != "decision":
            continue
        for old in conflict.ordered_candidates(c, existing):
            _, conflicts, failure = judge(c, [old], llm, decider)
            if failure:
                incomplete += 1
            found += [(x["cardA"]["id"].split("#")[0], mid, x["judgement"]) for x in conflicts]
        existing.append(c)
    rows, outcomes = [], []
    for p in pairs:
        olds = {u.split("-")[0] for u in _units(p["old_unit"])}
        new = _units(p["new_unit"])[0].split("-")[0]
        hit = [j for o, n, j in found if o in olds and n == new]
        want = p["label"].replace("바뀜", "변경")
        outcomes.append((should_alert(want), bool(hit)))
        rows.append({"pair": p["pair_id"], "want": want, "alerts": hit})
    return {**alert_rates(outcomes), "total_alerts": len(found), "incomplete_pairs": incomplete,
            "rows": rows, "all_alerts": found}


def _print_judge_rows(rows) -> None:
    for r in rows:
        print(f"{'✓' if r['ok'] else '✗'} {r['pair']} [{r['want']} → {', '.join(r['got'])}] {r['old']}  vs  {r['new']}")


def _classify_and_e2e(what, msgs, gold, pairs, llm, decider) -> tuple[dict, dict]:
    preds, failed = run_classify(msgs, llm, decider)
    failed_ids = {f["session"] for f in failed}
    scored = [m for m in msgs if m["conversationId"] not in failed_ids]  # 실패한 세션은 채점하지 않는다
    acc, rows = score_classify(scored, gold, preds)
    acc["incomplete_sessions"] = len(failed)
    res = {"classify": acc, "rows": rows, "preds": preds, "failed_sessions": failed}
    summary = {"classify": acc}
    if what == "e2e":
        e2e = eval_e2e(preds, pairs, llm, decider)
        res["e2e"] = e2e
        summary["e2e"] = {k: v for k, v in e2e.items() if k not in ("rows", "all_alerts")}
    return res, summary


def main() -> int:
    load_env()
    what = sys.argv[1] if len(sys.argv) > 1 else "judge"
    rule = "--rule" in sys.argv
    msgs, gold, pairs = load()
    llm = decider = None
    if not rule:
        try:
            llm = from_env()
        except LLMNotConfigured as e:
            print(e, file=sys.stderr)
            return 1
        decider = decider_from_env()
    print(f"판정: {'Decisions' if decider else ('chat 모델' if llm else '규칙')}", file=sys.stderr)

    if what == "judge":
        res = eval_judge(gold, pairs, llm, decider)
        _print_judge_rows(res["rows"])
        summary = {k: v for k, v in res.items() if k != "rows"}
    elif what not in ("classify", "e2e"):
        print(__doc__, file=sys.stderr)
        return 2
    elif llm is None:
        print("분류 평가는 외부 AI 가 필요합니다.", file=sys.stderr)
        return 1
    else:
        res, summary = _classify_and_e2e(what, msgs, gold, pairs, llm, decider)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"저장: {save_result(f'sheet-{what}' + ('-rule' if rule else ''), res)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
