// 승인 전 미리 알림 (collector/team_decisions.py). 후보 결정이 같은 세부 주제의 현재 팀 결정과 어긋나면 후보를 만든 본인에게만 보인다.
// 팀에는 아무것도 보내지 않는다. 최종 판정은 승인 뒤 팀 서버의 충돌 검사가 하고, 그 결과는 지금처럼 팀 전체에 알린다.

/** 어긋나는 현재 팀 결정 (팀 보드에 이미 공유된 내용) */
export interface TeamDecisionRef {
  id: string;
  topic_key: string;
  content: string;
}

/** 후보 한 장의 미리 알림 (candidates.list 의 preAlert. 없으면 null) */
export interface PreAlert {
  key: string; // 주제·내용·팀 결정이 같으면 같은 값: 두 대화에서 나온 같은 결정은 한 번만 알린다
  topicKey: string; // 팀 결정의 세부 주제
  decisions: TeamDecisionRef[]; // 최근 승인 먼저
}

/** collection.status 의 preAlerts 한 줄: key 하나에 후보가 몇 장인지. 후보 문장은 들어 있지 않다 */
export interface PreAlertSummary extends PreAlert {
  candidates: number;
}

export const PRE_ALERT_LABEL = "팀 결정과 어긋남";
export const PRE_ALERT_HINT = "승인 전 미리 알림이에요. 나에게만 보이고, 최종 판정은 승인 뒤 팀 서버가 해요.";

// 숫자를 한국어로 읽을 때 받침이 있는 것 (영·일·삼·육·칠·팔)
const DIGIT_WITH_FINAL = new Set("013678");

/** 앞말 끝소리에 맞춘 '과'/'와'. 한글·숫자로 끝나지 않으면 '과(와)' */
export function gwaWa(text: string): string {
  const last = [...text.trim()].reverse().find((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (!last) return "과(와)";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? "과" : "와";
  if (/[0-9]/.test(last)) return DIGIT_WITH_FINAL.has(last) ? "과" : "와";
  return "과(와)";
}

/** "이 후보는 팀 결정 '확장 지원 = 크롬 우선'과 어긋나요(미리 알림)" */
export function preAlertText(alert: Pick<PreAlert, "decisions">): string {
  const [first] = alert.decisions;
  if (!first) return "";
  const others = alert.decisions.length - 1;
  const named = others > 0 ? `'${first.content}' 외 ${others}건` : `'${first.content}'`;
  return `이 후보는 팀 결정 ${named}${gwaWa(others > 0 ? "건" : first.content)} 어긋나요(미리 알림)`;
}
