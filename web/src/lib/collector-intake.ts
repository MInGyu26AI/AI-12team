// 웹 백업 입력(붙여넣기·내보내기 파일)을 로컬 수집기 분류 대기함에 넣는다 (실제 모드).
// 수집기가 개인정보 검사와 외부 AI 분류를 거쳐 승인함 후보로 만든다.
import type { CollectedMessage } from "@shared/collector";
import type { Utterance } from "@shared/utterance";
import { rpc } from "./rpc";

const APPEND_CHUNK = 200; // turns.append 한 번에 보내는 발화 수

// turns.append 응답 중 화면에 알릴 것 (collector/turn_intake.py append). 옛 수집기는 일부 필드가 없다
interface AppendResult {
  newMessages: number; // 실제로 저장한 발화
  intakeIssues?: unknown[]; // 형식 오류·같은 id 의 다른 내용 → 분류하지 않고 따로 보관
  teamRecordSkipped?: number; // 붙여 넣은 팀 기록이라 뺀 발화
  elsewhereDuplicates?: number; // 다른 대화에서 이미 보낸 발화
}

/** 보낸 발화가 어떻게 처리됐는지. stored 외의 나머지는 이미 보낸 같은 발화(중복) */
export interface IntakeSummary {
  sent: number;
  stored: number;
  quarantined: number;
  teamRecord: number;
  elsewhere: number;
}

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

/** 마지막 묶음에서 flush 해 10턴이 안 되는 남은 대화까지 분류에 보낸다. 묶음마다의 응답을 더해 돌려준다 */
export async function appendToCollector(utterances: Utterance[]): Promise<IntakeSummary> {
  const messages = toMessages(utterances);
  const summary: IntakeSummary = { sent: messages.length, stored: 0, quarantined: 0, teamRecord: 0, elsewhere: 0 };
  for (let start = 0; start < messages.length; start += APPEND_CHUNK) {
    const end = start + APPEND_CHUNK;
    const r = await rpc<AppendResult>("turns.append", { messages: messages.slice(start, end), flush: end >= messages.length });
    summary.stored += r.newMessages ?? 0;
    summary.quarantined += r.intakeIssues?.length ?? 0;
    summary.teamRecord += r.teamRecordSkipped ?? 0;
    summary.elsewhere += r.elsewhereDuplicates ?? 0;
  }
  return summary;
}

/** 처리 결과를 사실대로 한 문장으로. 전부 들어간 게 아니면 warning */
export function intakeNotice(s: IntakeSummary): { tone: "success" | "warning"; text: string } {
  const duplicate = Math.max(0, s.sent - s.stored - s.quarantined - s.teamRecord - s.elsewhere);
  const notes = [
    s.quarantined && `${s.quarantined}개는 형식이 맞지 않거나 이미 보낸 메시지와 내용이 달라 분류하지 않고 수집기에 따로 보관했어요`,
    s.teamRecord && `${s.teamRecord}개는 붙여 넣은 팀 기록이라 뺐어요`,
    s.elsewhere && `${s.elsewhere}개는 다른 대화에서 이미 보낸 내용이라 뺐어요`,
    duplicate && `${duplicate}개는 이미 보낸 내용이에요`,
  ].filter(Boolean);
  const head = s.stored ? `${s.stored}개를 분류 대기함에 넣었어요.` : "새로 넣은 대화가 없어요.";
  if (!notes.length) return { tone: "success", text: `${head} 분류가 끝나면 승인함에 올라와요.` };
  return { tone: "warning", text: `${head} ${notes.join(" · ")}.` };
}
