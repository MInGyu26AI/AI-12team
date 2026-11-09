"""민규 님 샘플 대화·정답표로 평가.

  python3 -m eval.sheet_eval judge [--rule]   충돌 판정만 (정답 카드 사용). --rule 이면 AI 없이
  python3 -m eval.sheet_eval classify         분류 정확도 (멤버·날짜별 세션을 시간순으로 분류)
  python3 -m eval.sheet_eval e2e              분류 결과로 충돌까지 끝까지 (시연 흐름과 같음)
  결과: eval/results/sheet-*.json
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from syncup_ai import conflict
from syncup_ai.classify import classify_indexed
from syncup_ai.config import load_env
from syncup_ai.llm import LLMNotConfigured, decider_from_env, from_env

from .sheets import DATA, read_table

RESULTS = Path(__file__).resolve().parent / "results"
EXCEL_EPOCH = date(1899, 12, 30)
MEMBERS = ["박지민", "이서준", "정하린", "최유나"]
CONTEXT = {
    "teamName": "싱크업",
    "projectTopic": "대학생 팀플에서 팀원마다 다른 AI를 써서 흩어지는 결정을 모아 팀 결정 기록으로 공유하고 결정 충돌을 알려주는 서비스 (해커톤)",
    "knownNames": MEMBERS,
}
TAG = {"결정": "decision", "할 일": "todo", "조사": "research", "해당 없음": "none"}
SHAREABLE = ("decision", "todo", "research")


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
    """세션을 시간순으로 분류. 앞 세션의 결정은 '기존 팀 결정'으로 다음 요청에 들어간다 (모두 승인했다고 가정)."""
    preds = []  # (message_id, card)
    for sess in sessions(msgs):
        decisions = [c for _, c in preds if c["relevance"] == "related" and c["tag"] == "decision"]
        ctx = {**CONTEXT, "userName": sess[0]["member"],
               "existingTopicKeys": list(dict.fromkeys(c["topic_key"] for _, c in preds if c.get("topic_key"))),
               "existingDecisions": [{"topic_key": c["topic_key"], "content": c["content"]} for c in decisions]}
        req = {"type": "classify", "version": 1, "context": ctx,
               "messages": [{k: v for k, v in m.items() if not k.startswith("_") and k != "member"} for m in sess]}
        for pos, card in classify_indexed(req, llm, decider):
            card["id"] = f"{sess[pos]['id']}#{len(preds)}"
            card["status"] = "approved"
            preds.append((sess[pos]["id"], card))
        print(f"  분류: {sess[0]['conversationId']} ({len(sess)}발화)", file=sys.stderr)
    return preds


def score_classify(msgs, gold, preds):
    is_ai = {m["id"]: m["role"] == "assistant" for m in msgs}
    gold_by, pred_by = defaultdict(list), defaultdict(list)
    for g in gold:
        gold_by[g["message_id"]].append(g)
    for mid, c in preds:
        pred_by[mid].append(c)

    s, t = Counter(), Counter()
    rows = []
    for mid in [m["id"] for m in msgs]:
        G = [g for g in gold_by[mid] if g["relevance"] == "related" and g["tag"] in SHAREABLE]
        P = [c for c in pred_by[mid] if c["relevance"] == "related" and c["tag"] in SHAREABLE]
        left = list(P)
        for g in G:
            t["share_recall"] += 1
            t[f"recall_{g['tag']}"] += 1
            hit = next((c for c in left if c["tag"] == g["tag"]), None)
            if hit:
                left.remove(hit)
                s["share_recall"] += 1
                s[f"recall_{g['tag']}"] += 1
                for f in ("subtopic", "owner", "due", "is_change"):
                    if f == "owner" and g["tag"] == "research":
                        continue  # 조사의 owner_or_source 는 출처라 비교 안 함
                    if f in ("due",) and g["tag"] != "todo":
                        continue
                    if f == "is_change" and g["tag"] != "decision":
                        continue
                    t[f] += 1
                    s[f] += (hit.get(f) or None) == (g[f] or None) if f != "is_change" else bool(hit.get(f)) == g[f]
        t["share_precision"] += len(P)
        s["share_precision"] += len(P) - len(left)
        if is_ai[mid]:
            t["ai_msgs"] += 1
            s["ai_false_cards"] += len(left)  # AI 답변에서 정답에 없는 공유 후보
        all_personal = gold_by[mid] and all(g["relevance"] == "personal" for g in gold_by[mid])
        if all_personal:
            t["personal_msgs"] += 1
            s["personal_leak"] += bool(P)
        if any(g["masked"] for g in gold_by[mid]):
            t["masked_msgs"] += 1
            s["phone_leak"] += any(re.search(r"010-?\d{4}", c.get("sentence", "") + c.get("content", "")) for c in pred_by[mid])
        rows.append({"message_id": mid, "gold": [(g["tag"], g["topic_key"], g["text"]) for g in G],
                     "pred": [(c["tag"], c.get("topic_key"), c.get("sentence")) for c in P],
                     "extra": [(c["tag"], c.get("sentence")) for c in left]})

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
    rows, tp, fn, fp, tn, exact = [], 0, 0, 0, 0, 0
    for p in pairs:
        old = [_gold_card(by_unit[u]) for u in _units(p["old_unit"]) if u in by_unit]
        new_u = _units(p["new_unit"])[0]
        new = _gold_card(by_unit[new_u])
        judged, conflicts = conflict.check_new_decision(new, old, llm, decider)
        want = p["label"].replace("바뀜", "변경")
        alert = bool(conflicts)
        should = want in ("충돌", "변경")
        tp += should and alert; fn += should and not alert; fp += (not should) and alert; tn += (not should) and not alert
        got = [j["judgement"] for j in judged] or ["비교 안 함"]
        exact += want in got or (want == "비교 안 함" and set(got) <= {"무관", "비교 안 함"})
        rows.append({"pair": p["pair_id"], "want": want, "got": got, "old": p["old_text"], "new": p["new_text"],
                     "reason": [j["reason"] for j in judged]})
    return {"detection_rate": round(tp / max(tp + fn, 1), 3), "false_alarm_rate": round(fp / max(fp + tn, 1), 3),
            "label_accuracy": round(exact / len(pairs), 3), "rows": rows}


# ── 3) 끝까지: 예측 카드 → 충돌 ──
def eval_e2e(preds, pairs, llm, decider):
    existing, found = [], []  # found: (old message_id, new message_id, judgement)
    for mid, c in preds:
        if c["relevance"] == "related" and c["tag"] == "decision":
            _, conflicts = conflict.check_new_decision(c, existing, llm, decider)
            found += [(x["cardA"]["id"].split("#")[0], mid, x["judgement"]) for x in conflicts]
            existing.append(c)
    rows, tp, fn, fp, tn = [], 0, 0, 0, 0
    for p in pairs:
        olds = {u.split("-")[0] for u in _units(p["old_unit"])}
        new = _units(p["new_unit"])[0].split("-")[0]
        hit = [j for o, n, j in found if o in olds and n == new]
        want = p["label"].replace("바뀜", "변경")
        should = want in ("충돌", "변경")
        tp += should and bool(hit); fn += should and not hit; fp += (not should) and bool(hit); tn += (not should) and not hit
        rows.append({"pair": p["pair_id"], "want": want, "alerts": hit})
    return {"detection_rate": round(tp / max(tp + fn, 1), 3), "false_alarm_rate": round(fp / max(fp + tn, 1), 3),
            "total_alerts": len(found), "rows": rows, "all_alerts": found}


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
        for r in res["rows"]:
            print(f"{'✓' if r['want'] in r['got'] or (r['want'] == '비교 안 함' and set(r['got']) <= {'무관', '비교 안 함'}) else '✗'} "
                  f"{r['pair']} [{r['want']} → {', '.join(r['got'])}] {r['old']}  vs  {r['new']}")
        summary = {k: v for k, v in res.items() if k != "rows"}
    elif what in ("classify", "e2e"):
        if llm is None:
            print("분류 평가는 외부 AI 가 필요합니다.", file=sys.stderr)
            return 1
        preds = run_classify(msgs, llm, decider)
        acc, rows = score_classify(msgs, gold, preds)
        res = {"classify": acc, "rows": rows, "preds": preds}
        summary = {"classify": acc}
        if what == "e2e":
            e2e = eval_e2e(preds, pairs, llm, decider)
            res["e2e"] = e2e
            summary["e2e"] = {k: v for k, v in e2e.items() if k not in ("rows", "all_alerts")}
    else:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"sheet-{what}{'-rule' if rule else ''}-{datetime.now():%m%d-%H%M}.json"
    out.write_text(json.dumps(res, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"저장: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
