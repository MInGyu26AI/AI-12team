"""대화 횟수 기준으로 묶어 보내기 (이용흐름도: 10턴마다, 질문+답변 = 1턴).

수집기는 새 발화를 쌓아 두다가 `take_ready_batches` 로 꽉 찬 묶음만 분류에 보낸다.
일시중지·종료 시각·수동 보내기 때는 flush=True 로 남은 것까지 보낸다.
TODO(조정 예정): 턴 수 외에 시간(예: 마지막 발화 후 N분)·문자 수 기준을 추가할지.
"""
from __future__ import annotations

from .config import CONTEXT_TURNS, TURNS_PER_BATCH

Message = dict  # shared/collector.ts CollectedMessage


def group_turns(messages: list[Message]) -> list[list[Message]]:
    """사용자 발화 하나 + 뒤따르는 AI 답변들 = 1턴. 대화(conversationId)가 바뀌면 새 턴."""
    turns: list[list[Message]] = []
    for m in messages:
        last = turns[-1] if turns else None
        same_conv = last is not None and last[0].get("conversationId") == m.get("conversationId")
        if last is not None and same_conv and m.get("role") == "assistant":
            last.append(m)
        else:
            turns.append([m])
    return turns


def take_ready_batches(
    pending: list[Message],
    turns_per_batch: int = TURNS_PER_BATCH,
    flush: bool = False,
) -> tuple[list[list[Message]], list[Message]]:
    """(보낼 묶음들, 아직 남겨 둘 발화). 마지막 턴은 AI 답변이 더 올 수 있어 flush 가 아니면 남긴다."""
    turns = group_turns(pending)
    if not flush and turns and turns[-1][-1].get("role") == "user":
        open_turn = turns.pop()  # 답변을 아직 못 받은 턴
    else:
        open_turn = []
    batches: list[list[Message]] = []
    while len(turns) >= turns_per_batch or (flush and turns):
        chunk, turns = turns[:turns_per_batch], turns[turns_per_batch:]
        batches.append([m for t in chunk for m in t])
    leftover = [m for t in turns for m in t] + open_turn
    return batches, leftover


def context_tail(previous_batch: list[Message], turns: int = CONTEXT_TURNS) -> list[Message]:
    """다음 묶음에 '참고용'으로 붙일 직전 턴들 (카드는 만들지 않음)."""
    if turns <= 0:
        return []
    return [m for t in group_turns(previous_batch)[-turns:] for m in t]
