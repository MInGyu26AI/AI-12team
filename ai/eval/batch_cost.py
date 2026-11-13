"""수집 주기(묶음 크기) 3·5·10턴 비교: AI 호출 수, 보내는 글자 수, 반영까지 기다리는 턴 (외부 AI 없이).

  python3 -m eval.batch_cost            # 합성 대화 30개 (python3 -m eval.synth 먼저)
  python3 -m eval.batch_cost --ai       # 같은 묶음을 실제로 분류해 정확도·응답 시간까지 (외부 AI 필요)

1) 합성 대화는 팀원당 3~4턴뿐이라, 팀 유형(해커톤·수업 팀플·공모전)마다 대화를 시간순으로 이어 한 사람의 수집 기록
   (약 90~100턴)처럼 흘려 넣는다. 발화를 하나씩 쌓으며 수집기와 같은 batch.take_ready_batches 로 꽉 찬 묶음을 보낸다.
   수집이 끝나면 남은 발화를 flush 로 보낸다 (수동 보내기·종료 직전과 같음).
2) 묶음마다 실제 분류 프롬프트(시스템 + 사용자, 앞 묶음 참고용 턴 포함)를 만들어 글자 수를 센다.
3) 기다림: 사용자 발화가 들어온 뒤 그 발화가 담긴 묶음이 나갈 때까지 들어온 턴 수. 마지막 flush 로만 나간 비율도 센다.
4) --ai: 묶음마다 분류를 실제로 부르고 걸린 시간의 중간값을 잰다. 정확도는 합성 정답표로 sheet_eval 과 같이 채점한다 (2차 최종 회의 3.3).
"""
from __future__ import annotations

import statistics
import sys
import time
from collections import defaultdict

from syncup_ai.batch import context_tail, group_turns, take_ready_batches
from syncup_ai.classify import _system_prompt, build_user_prompt
from syncup_ai.config import load_env
from syncup_ai.llm import LLMNotConfigured, decider_from_env, from_env

from .scoring import classify_positions, save_result
from .sheet_eval import score_classify
from .synth_eval import load

SIZES = (3, 5, 10)


def _streams() -> list[tuple[dict, list[dict], list[dict]]]:
    """(팀 정보, 발화 순서, 정답 문장) 목록. 팀 유형마다 대화를 시간순으로 이어 한 사람의 긴 수집 기록으로 본다."""
    by_type = defaultdict(list)
    for split in ("dev", "test"):
        for conv_id, c in load(split).items():
            by_type[conv_id[0]].append(c)
    out = []
    for convs in by_type.values():
        msgs = sorted((m for c in convs for m in c["msgs"]), key=lambda m: (m["_at"], m["id"]))
        out.append(({**convs[0]["context"], "userName": "팀원"}, msgs, [g for c in convs for g in c["gold"]]))
    return out


def _clean(m: dict) -> dict:
    return {k: v for k, v in m.items() if not k.startswith("_") and k != "member"}


def _batches(msgs: list[dict], size: int) -> list[tuple[list[dict], list[dict], list[int], bool]]:
    """수집기처럼 발화를 하나씩 쌓으며 나가는 묶음들. (묶음, 앞 묶음, 기다린 턴들, 종료 때 나갔는지)"""
    out, pending, previous = [], [], []
    arrived, seen = {}, 0  # 사용자 발화 id → 들어왔을 때까지의 턴 수
    for m in msgs:
        pending.append(_clean(m))
        if m["role"] == "user":
            seen += 1
            arrived[m["id"]] = seen
        ready, pending = take_ready_batches(pending, size)
        for batch in ready:
            waited = [seen - arrived[x["id"]] for x in batch if x["id"] in arrived]
            out.append((batch, previous, waited, False))
            previous = batch
    if pending:  # 수집 종료: 남은 발화를 한 번에 보낸다
        out.append((pending, previous, [], True))
    return out


def simulate(size: int, llm=None, decider=None) -> dict:
    system_chars = len(_system_prompt())
    calls = chars = turns = user_msgs = sent_at_end = failed = 0
    waits, seconds, preds = [], [], []
    all_msgs, all_gold = [], []
    for context, msgs, gold in _streams():
        all_msgs += msgs
        all_gold += gold
        turns += len(group_turns([_clean(m) for m in msgs]))
        user_msgs += sum(1 for m in msgs if m["role"] == "user")
        for batch, previous, waited, at_end in _batches(msgs, size):
            prompt, _ = build_user_prompt(context, batch, context_tail(previous))
            calls += 1
            chars += system_chars + len(prompt)
            waits += waited
            if at_end:
                sent_at_end += sum(1 for m in batch if m["role"] == "user")
            if llm is not None:
                cards, took, ok = _classify(context, batch, previous, llm, decider)
                preds += cards
                seconds.append(took)
                failed += 0 if ok else 1
    per100 = 100 / max(turns, 1)
    result = {"turns_per_batch": size, "turns": turns, "calls": calls,
              "calls_per_100_turns": round(calls * per100, 1), "chars_per_call": round(chars / max(calls, 1)),
              "chars_per_100_turns": round(chars * per100), "avg_wait_turns": round(sum(waits) / max(len(waits), 1), 2),
              "sent_only_at_end": round(sent_at_end / max(user_msgs, 1), 3)}
    if llm is not None:
        acc, _ = score_classify(all_msgs, all_gold, preds)
        result.update(classify=acc, failed_batches=failed, median_seconds=round(statistics.median(seconds), 2))
    return result


def _classify(context, batch, previous, llm, decider) -> tuple[list, float, bool]:
    """묶음 하나를 실제로 분류한다. ([(발화 id, 카드)], 걸린 초, 성공 여부)"""
    req = {"type": "classify", "version": 1, "context": context, "messages": batch,
           "contextMessages": context_tail(previous)}
    start = time.monotonic()
    cards, failure = classify_positions(req, llm, decider)
    return [(batch[pos]["id"], card) for pos, card in cards], time.monotonic() - start, failure is None


def main() -> None:
    llm = decider = None
    if "--ai" in sys.argv:
        load_env()
        try:
            llm = from_env()
        except LLMNotConfigured as e:
            sys.exit(f"외부 AI 설정이 없습니다: {e}")
        decider = decider_from_env()
    rows = [simulate(n, llm, decider) for n in SIZES]
    print(f"{'묶음':>4} {'호출/100턴':>10} {'글자/호출':>9} {'글자/100턴':>10} {'평균 기다림(턴)':>14} {'종료 때만 전송':>12}")
    for r in rows:
        print(f"{r['turns_per_batch']:>4} {r['calls_per_100_turns']:>10} {r['chars_per_call']:>9} "
              f"{r['chars_per_100_turns']:>10} {r['avg_wait_turns']:>14} {r['sent_only_at_end']:>12.0%}")
    for r in rows:
        if "classify" in r:
            c = r["classify"]
            print(f"{r['turns_per_batch']:>4}턴: 공유 재현율 {c.get('share_recall')} · 정밀도 {c.get('share_precision')} · "
                  f"결정 재현율 {c.get('recall_decision')} · 응답 중간값 {r['median_seconds']}초 · 실패 묶음 {r['failed_batches']}")
    print(save_result("batch-cost" + ("-ai" if llm else ""), {"rows": rows}))


if __name__ == "__main__":
    main()
