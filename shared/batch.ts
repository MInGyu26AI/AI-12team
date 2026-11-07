// 대화 횟수 기준 묶기 — ai/syncup_ai/batch.py 를 그대로 옮김 (김하은 님 코드와 같은 규칙).
// 사용자 발화 하나 + 뒤따르는 AI 답변들 = 1턴, TURNS_PER_BATCH 턴마다 분류에 보낸다.
// 일시중지·종료 시각·수동 보내기 때는 flush=true 로 남은 것까지 보낸다.
import type { CollectedMessage } from "./collector";

export const TURNS_PER_BATCH = 10; // config.TURNS_PER_BATCH (시연하며 조정)

/** 사용자 발화 하나 + 뒤따르는 AI 답변들 = 1턴. 대화(conversationId)가 바뀌면 새 턴 */
export function groupTurns(messages: CollectedMessage[]): CollectedMessage[][] {
  const turns: CollectedMessage[][] = [];
  for (const m of messages) {
    const last = turns.at(-1);
    const sameConv = last !== undefined && last[0]!.conversationId === m.conversationId;
    if (last && sameConv && m.role === "assistant") last.push(m);
    else turns.push([m]);
  }
  return turns;
}

/** (보낼 묶음들, 아직 남겨 둘 발화). 마지막 턴은 AI 답변이 더 올 수 있어 flush 가 아니면 남긴다 */
export function takeReadyBatches(
  pending: CollectedMessage[],
  turnsPerBatch = TURNS_PER_BATCH,
  flush = false,
): { batches: CollectedMessage[][]; leftover: CollectedMessage[] } {
  let turns = groupTurns(pending);
  let openTurn: CollectedMessage[] = [];
  if (!flush && turns.length && turns.at(-1)!.at(-1)!.role === "user") {
    openTurn = turns.pop()!; // 답변을 아직 못 받은 턴
  }
  const batches: CollectedMessage[][] = [];
  while (turns.length >= turnsPerBatch || (flush && turns.length)) {
    batches.push(turns.slice(0, turnsPerBatch).flat());
    turns = turns.slice(turnsPerBatch);
  }
  return { batches, leftover: [...turns.flat(), ...openTurn] };
}

export const countTurns = (messages: CollectedMessage[]) => groupTurns(messages).length;
