// 웹 백업 입력(붙여넣기·내보내기 파일)을 로컬 수집기 분류 대기함에 넣는다 (실제 모드).
// 수집기가 개인정보 검사와 외부 AI 분류를 거쳐 승인함 후보로 만든다.
import type { CollectedMessage } from "@shared/collector";
import type { Utterance } from "@shared/utterance";
import { rpc } from "./rpc";

const APPEND_CHUNK = 200; // turns.append 한 번에 보내는 발화 수

function toMessages(utterances: Utterance[]): CollectedMessage[] {
  const conversationId = crypto.randomUUID(); // 붙여넣기는 대화 id 가 없으니 한 번 넣은 것을 한 대화로 본다
  return utterances.map((u, i) => ({
    id: u.id ?? `${conversationId}:${i}`,
    conversationId: u.conversationId ?? conversationId,
    collectedAt: u.collectedAt ?? new Date().toISOString(),
    site: u.conversationId ? "chatgpt-export" : "manual",
    role: u.speaker === "ai" ? "assistant" : "user",
    roleGuessed: u.roleGuessed ?? true,
    text: u.text,
  }));
}

/** 마지막 묶음에서 flush 해 10턴이 안 되는 남은 대화까지 분류에 보낸다 */
export async function appendToCollector(utterances: Utterance[]) {
  const messages = toMessages(utterances);
  for (let start = 0; start < messages.length; start += APPEND_CHUNK) {
    const end = start + APPEND_CHUNK;
    await rpc("turns.append", { messages: messages.slice(start, end), flush: end >= messages.length });
  }
}
