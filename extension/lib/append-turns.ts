// 화면에서 읽은 발화를 로컬 수집기에 넣는다. 수집기 turns.append 는 한 번에 1~200개만 받으므로 나눠 보내고,
// 지금 분류하라는 flush 는 마지막 묶음에만 붙인다. 웹 붙여넣기(collect/paste)와 같은 규칙이다.
import type { CollectedMessage } from '@shared/collector';
import { rpc } from './collector-rpc';
import { clearErrorAndRefresh } from './collector-status';
import type { CollectResult } from './messages';

const APPEND_LIMIT = 200;

interface AppendResult {
  newMessages: number;
  intakeIssues: unknown[];
}

export async function appendTurns(messages: CollectedMessage[], flush: boolean): Promise<CollectResult> {
  let newMessages = 0;
  let intakeIssues = 0;
  for (let start = 0; start < messages.length; start += APPEND_LIMIT) {
    const isLast = start + APPEND_LIMIT >= messages.length;
    const chunk = messages.slice(start, start + APPEND_LIMIT);
    const result = await rpc<AppendResult>('turns.append', { messages: chunk, flush: flush && isLast });
    newMessages += result.newMessages;
    intakeIssues += result.intakeIssues.length;
  }
  await clearErrorAndRefresh();
  return { ok: true, newMessages, intakeIssues };
}
