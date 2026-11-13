"""수집 주기(묶음 크기) 3·5·10턴 비교: AI 호출 수, 보내는 글자 수, 반영까지 기다리는 턴 (외부 AI 없이).

  python3 -m eval.batch_cost            # 합성 대화 30개 (python3 -m eval.synth 먼저)

1) 합성 대화는 팀원당 3~4턴뿐이라, 팀 유형(해커톤·수업 팀플·공모전)마다 대화를 시간순으로 이어 한 사람의 수집 기록
   (약 90~100턴)처럼 흘려 넣는다. 발화를 하나씩 쌓으며 수집기와 같은 batch.take_ready_batches 로 꽉 찬 묶음을 보낸다.
   수집이 끝나면 남은 발화를 flush 로 보낸다 (수동 보내기·종료 직전과 같음).
2) 묶음마다 실제 분류 프롬프트(시스템 + 사용자, 앞 묶음 참고용 턴 포함)를 만들어 글자 수를 센다.
3) 기다림: 사용자 발화가 들어온 뒤 그 발화가 담긴 묶음이 나갈 때까지 들어온 턴 수. 마지막 flush 로만 나간 비율도 센다.
정확도·응답 시간은 외부 AI 가 필요해서 synth_eval e2e 를 묶음 크기별로 돌려 따로 잰다 (2차 최종 회의 3.3).
"""
from __future__ import annotations

from collections import defaultdict

from syncup_ai.batch import context_tail, group_turns, take_ready_batches
from syncup_ai.classify import _system_prompt, build_user_prompt

from .scoring import save_result
from .synth_eval import load

SIZES = (3, 5, 10)


def _streams() -> list[tuple[dict, list[dict]]]:
    """(팀 정보, 발화 순서) 목록. 팀 유형마다 대화를 시간순으로 이어 한 사람의 긴 수집 기록으로 본다."""
    by_type = defaultdict(list)
    for split in ("dev", "test"):
        for conv_id, c in load(split).items():
            by_type[conv_id[0]].append(c)
    out = []
    for convs in by_type.values():
        msgs = sorted((m for c in convs for m in c["msgs"]), key=lambda m: (m["_at"], m["id"]))
        out.append(({**convs[0]["context"], "userName": "팀원"}, msgs))
    return out


def _clean(m: dict) -> dict:
    return {k: v for k, v in m.items() if not k.startswith("_") and k != "member"}


def simulate(size: int) -> dict:
    system_chars = len(_system_prompt())
    calls, chars, waits, flushed, user_msgs, turns = 0, 0, [], 0, 0, 0
    for context, msgs in _streams():
        pending, previous, arrived = [], [], {}  # arrived: 사용자 발화 id → 들어왔을 때까지의 턴 수
        seen_turns = 0
        for m in msgs:
            pending.append(_clean(m))
            if m["role"] == "user":
                seen_turns += 1
                arrived[m["id"]] = seen_turns
            ready, pending = take_ready_batches(pending, size)
            for batch in ready:
                prompt, _ = build_user_prompt(context, batch, context_tail(previous))
                calls, chars = calls + 1, chars + system_chars + len(prompt)
                waits += [seen_turns - arrived[x["id"]] for x in batch if x["id"] in arrived]
                previous = batch
        if pending:  # 수집 종료: 남은 발화를 한 번에 보낸다
            prompt, _ = build_user_prompt(context, pending, context_tail(previous))
            calls, chars = calls + 1, chars + system_chars + len(prompt)
            flushed += sum(1 for x in pending if x["id"] in arrived)
        user_msgs += len(arrived)
        turns += len(group_turns([_clean(m) for m in msgs]))
    per100 = 100 / max(turns, 1)
    return {"turns_per_batch": size, "turns": turns, "calls": calls, "calls_per_100_turns": round(calls * per100, 1),
            "chars_per_call": round(chars / max(calls, 1)), "chars_per_100_turns": round(chars * per100),
            "avg_wait_turns": round(sum(waits) / max(len(waits), 1), 2),
            "sent_only_at_end": round(flushed / max(user_msgs, 1), 3)}


def main() -> None:
    rows = [simulate(n) for n in SIZES]
    print(f"{'묶음':>4} {'호출/100턴':>10} {'글자/호출':>9} {'글자/100턴':>10} {'평균 기다림(턴)':>14} {'종료 때만 전송':>12}")
    for r in rows:
        print(f"{r['turns_per_batch']:>4} {r['calls_per_100_turns']:>10} {r['chars_per_call']:>9} "
              f"{r['chars_per_100_turns']:>10} {r['avg_wait_turns']:>14} {r['sent_only_at_end']:>12.0%}")
    print(save_result("batch-cost", {"rows": rows}))


if __name__ == "__main__":
    main()
