// 파일 발화를 로컬 수집기(turns.append)로 보낸다. 붙여넣기(collector-intake.ts appendToCollector)와 같은 방식:
// 200개씩 나눠 보내고 마지막 묶음에서 flush 해, 수집기가 돌려준 개수를 그대로 더해 사실대로 알린다.
import type { IntakeSummary } from "@/lib/collector-intake";
import { rpc } from "@/lib/rpc";
import type { FileUploadMessage } from "./types";

/** turns.append 한 번에 보내는 발화 수 */
export const APPEND_SLICE = 200;

// turns.append 응답 중 화면에 알릴 것 (collector/turn_intake.py append). 옛 수집기는 일부 필드가 없다
interface AppendResult {
  newMessages: number;
  intakeIssues?: unknown[];
  teamRecordSkipped?: number;
  elsewhereDuplicates?: number;
}

export async function sendFileMessages(
  messages: FileUploadMessage[],
  opts: { call?: typeof rpc; onProgress?: (done: number, total: number) => void } = {},
): Promise<IntakeSummary> {
  const call = opts.call ?? rpc;
  const summary: IntakeSummary = { sent: messages.length, stored: 0, quarantined: 0, teamRecord: 0, elsewhere: 0 };
  for (let start = 0; start < messages.length; start += APPEND_SLICE) {
    const end = Math.min(start + APPEND_SLICE, messages.length);
    const r = await call<AppendResult>("turns.append", { messages: messages.slice(start, end), flush: end >= messages.length });
    summary.stored += r.newMessages ?? 0;
    summary.quarantined += r.intakeIssues?.length ?? 0;
    summary.teamRecord += r.teamRecordSkipped ?? 0;
    summary.elsewhere += r.elsewhereDuplicates ?? 0;
    opts.onProgress?.(end, messages.length);
  }
  return summary;
}

/** 처리 결과를 사실대로 한 문장으로 (intakeNotice 와 같은 방식). 전부 들어간 게 아니면 warning */
export function fileIntakeNotice(s: IntakeSummary): { tone: "success" | "warning"; text: string } {
  const duplicate = Math.max(0, s.sent - s.stored - s.quarantined - s.teamRecord - s.elsewhere);
  const notes = [
    s.quarantined && `${s.quarantined}조각은 형식이 맞지 않거나 이미 보낸 조각과 내용이 달라 분류하지 않고 수집기에 따로 보관했어요`,
    s.teamRecord && `${s.teamRecord}조각은 팀 기록이라 뺐어요`,
    s.elsewhere && `${s.elsewhere}조각은 다른 자료에서 이미 보낸 내용이라 뺐어요`,
    duplicate && `${duplicate}조각은 이미 올린 내용이에요`,
  ].filter(Boolean);
  const head = s.stored ? `${s.stored}조각을 분류 대기함에 넣었어요.` : "새로 넣은 내용이 없어요.";
  if (!notes.length) return { tone: "success", text: `${head} 분류가 끝나면 승인함에 올라와요.` };
  return { tone: "warning", text: `${head} ${notes.join(" · ")}.` };
}
