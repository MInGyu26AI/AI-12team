"""대화 횟수 기준으로 묶어 보내기 (이용흐름도: 10턴마다, 질문+답변 = 1턴).

수집기는 새 발화를 쌓아 두다가 `take_ready_batches` 로 꽉 찬 묶음만 분류에 보낸다.
수동 보내기 때는 flush=True 로 남은 것까지 보낸다. 일시중지·종료 때 남은 발화는 보내지 않고 로컬에 둔다.
turnId 가 있는 발화(코딩 도구 로그)는 같은 turnId 끼리 한 턴이고, complete=True 인 사용자 발화는 답을 기다리지 않는다.
"""
from __future__ import annotations

from .config import CONTEXT_TURNS, TURNS_PER_BATCH

Message = dict  # shared/collector.ts CollectedMessage


def _continues(turn: list[Message], m: Message) -> bool:
    """m 이 이 턴에 이어지는 발화인가: 같은 대화이고, 같은 turnId 이거나 (turnId 가 없으면) AI 답변."""
    first = turn[0]
    if first.get("conversationId") != m.get("conversationId"):
        return False
    if m.get("turnId"):
        return first.get("turnId") == m["turnId"]
    return m.get("role") == "assistant"


def group_turns(messages: list[Message]) -> list[list[Message]]:
    """사용자 발화 하나 + 뒤따르는 AI 답변들 = 1턴. 대화(conversationId)가 바뀌면 새 턴."""
    turns: list[list[Message]] = []
    for m in messages:
        if turns and _continues(turns[-1], m):
            turns[-1].append(m)
        else:
            turns.append([m])
    return turns


def take_ready_batches(
    pending: list[Message],
    turns_per_batch: int = TURNS_PER_BATCH,
    flush: bool = False,
) -> tuple[list[list[Message]], list[Message]]:
    """(보낼 묶음들, 아직 남겨 둘 발화). 답을 하나도 못 받은 마지막 질문만 flush 가 아니면 남긴다.

    답이 하나라도 있는 턴은 묶음에 들어간다. 그 뒤에 같은 질문의 답(다시 생성 등)이 오면 다음 묶음에서 질문 없는 턴이 된다."""
    turns = group_turns(pending)
    if not flush and turns and turns[-1][-1].get("role") == "user" and not turns[-1][-1].get('complete'):
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
