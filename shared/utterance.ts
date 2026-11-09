// 웹 백업 입력(대화 붙여넣기·ChatGPT 내보내기 파일)이 만드는 발화. 두 모드 공용:
// 실제 모드는 로컬 수집기(turns.append)로 보내고, 목업 모드는 shared/classify.ts mockClassify 로 분류한다.
import type { Speaker } from "./types";

export interface Utterance {
  id?: string;
  conversationId?: string;
  collectedAt?: string;
  roleGuessed?: boolean;
  speaker: Speaker;
  text: string;
  source: string; // 예: "ChatGPT, 2026-11-06 21:10" (format.ts formatSource)
}

// "나:", "You said:", "ChatGPT:" 같은 화자 표시
const USER_PREFIX = /^(?:나|me|user|you said|you|사용자)\s*:?\s*$|^(?:나|me|user|you|사용자)\s*:\s*/i;
const AI_PREFIX = /^(?:chatgpt|gpt|claude|gemini|ai|assistant)(?: said)?\s*:?\s*$|^(?:chatgpt|gpt|claude|gemini|ai|assistant)\s*:\s*/i;

/** 붙여넣은 대화 → 발화. 화자 표시가 없는 줄은 앞 화자를 이어 받고, 처음엔 사용자로 추정한다 */
export function parsePasted(text: string, source: string): Utterance[] {
  const out: Utterance[] = [];
  let speaker: Speaker = "user";
  let roleGuessed = true;
  for (const line of text.split(/\r?\n/)) {
    let body = line;
    if (USER_PREFIX.test(line)) {
      speaker = "user";
      roleGuessed = false;
      body = line.replace(USER_PREFIX, "");
    } else if (AI_PREFIX.test(line)) {
      speaker = "ai";
      roleGuessed = false;
      body = line.replace(AI_PREFIX, "");
    }
    if (!body.trim()) continue;
    const last = out.at(-1);
    if (last && last.speaker === speaker && last.roleGuessed === roleGuessed) last.text += "\n" + body;
    else out.push({ speaker, text: body, source, roleGuessed });
  }
  return out;
}
