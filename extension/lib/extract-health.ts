// 화면 구조 변경 감지 (기능 A): 한 번의 화면 추출 결과가 "정상으로 읽혔는지"를 판정한다.
// ChatGPT 화면이 바뀌어 대화를 못 읽거나 엉뚱하게 읽으면 배지 `!` 와 팝업 안내로 알리기 위한 순수 함수다.
// DOM · browser API 를 쓰지 않고, 대화 내용(글·제목·주소)을 받지도 내보내지도 않는다.
// 입력은 TabPingResult 와 같은 모양(onConversation · messageCount · selector · guessedRoles)에 선택 필드를 더한 것이라
// 팝업은 ping 결과를 그대로 넣을 수 있다.
import type { ExtractResult } from './sites/types';

// ── 문턱값 ────────────────────────────────────────────────────
// 앞쪽 전략은 data-* 속성처럼 화면이 직접 알려 주는 표시를 읽는다. 아래 전략은 "main 안의 비슷한 블록"을 짐작으로 읽어서,
// 앞쪽 전략이 모두 빈손일 때만 먹는다 (lib/sites/chatgpt.ts 의 SELECTORS.strategies 맨 아래 3개 + repeated-blocks).
// 이 전략이 먹혔다는 것은 ChatGPT 화면 구조가 바뀌어 속성 기반 전략이 깨졌다는 신호다.
export const FALLBACK_STRATEGIES: readonly string[] = ['article', 'content-blocks', 'repeated-blocks'];

// 화자 추정·빈 본문 비율 경고 기준: 메시지가 이만큼 이상일 때만 비율을 본다 (1~2개 중 하나는 우연일 수 있다)
export const RATIO_MIN_MESSAGES = 3;
// 이 비율 이상이면 경고
export const GUESSED_ROLES_RATIO_WARN = 0.3;
export const EMPTY_BODIES_RATIO_WARN = 0.3;

// ── 타입 ──────────────────────────────────────────────────────
/** 한 번의 화면 추출 요약. TabPingResult 에서 site 만 뺀 모양이라 ping 결과도 그대로 받는다 */
export interface ExtractSummary {
  onConversation: boolean; // /c/... 대화 화면인지
  messageCount: number; // 읽은 메시지 수 (빈 본문은 이미 뺀 수)
  selector: string | null; // 먹힌 전략 이름. 못 읽었으면 null
  guessedRoles: number; // 화자를 순서로 추정한 메시지 수
  /** 글이 비어 메시지로 세지 않은 요소 수. 모르면 생략(0 으로 본다) */
  emptyBodies?: number;
  /** 전략별로 잡힌 요소 수 (ExtractResult.tried). 진단 복사에만 쓴다 */
  tried?: readonly { name: string; count: number }[];
}

export type HealthReasonCode =
  | 'no-messages' // 대화 화면인데 읽은 메시지가 0건
  | 'fallback-strategy' // 속성 기반 전략이 깨지고 짐작 전략이 먹음
  | 'many-guessed-roles' // 화자를 읽지 못한 메시지가 많음
  | 'many-empty-bodies'; // 글이 빈 요소가 많음

export interface HealthReason {
  code: HealthReasonCode;
  message: string; // 팝업에 그대로 보여 줄 한 줄
}

export type ExtractHealth = { status: 'ok'; reasons: [] } | { status: 'warn'; reasons: HealthReason[] };

// ── 판정 ──────────────────────────────────────────────────────
const count = (n: number | undefined) => (Number.isFinite(n) && n! > 0 ? Math.trunc(n!) : 0);
const percent = (part: number, whole: number) => Math.round((part / whole) * 100);

export function assessExtractHealth(summary: ExtractSummary): ExtractHealth {
  // 대화 화면이 아니면 읽을 대화가 없는 게 정상이다
  if (!summary.onConversation) return { status: 'ok', reasons: [] };

  const messages = count(summary.messageCount);
  const guessed = count(summary.guessedRoles);
  const empty = count(summary.emptyBodies);
  const reasons: HealthReason[] = [];

  if (messages === 0) {
    reasons.push({ code: 'no-messages', message: '대화 화면인데 메시지를 한 건도 읽지 못했어요. ChatGPT 화면 구조가 바뀌었을 수 있어요' });
  }
  if (summary.selector && FALLBACK_STRATEGIES.includes(summary.selector)) {
    reasons.push({
      code: 'fallback-strategy',
      message: '화면에서 메시지를 정확히 짚지 못하고 짐작으로 읽고 있어요. 읽은 내용이 어긋날 수 있어요',
    });
  }
  // 비율 판정의 분모: 화자 추정은 읽은 메시지, 빈 본문은 (읽은 메시지 + 빈 요소) 중 빈 요소의 몫
  if (messages >= RATIO_MIN_MESSAGES && guessed / messages >= GUESSED_ROLES_RATIO_WARN) {
    reasons.push({
      code: 'many-guessed-roles',
      message: `메시지 ${messages}개 중 ${guessed}개(${percent(guessed, messages)}%)는 누가 말했는지 읽지 못해 순서로 추정했어요`,
    });
  }
  const elements = messages + empty;
  if (elements >= RATIO_MIN_MESSAGES && empty / elements >= EMPTY_BODIES_RATIO_WARN) {
    reasons.push({
      code: 'many-empty-bodies',
      message: `읽으려던 ${elements}개 중 ${empty}개(${percent(empty, elements)}%)는 글이 비어 있었어요`,
    });
  }

  return reasons.length ? { status: 'warn', reasons } : { status: 'ok', reasons: [] };
}

/** ExtractResult 와 "대화 화면 여부"로 요약을 만든다. emptyBodies 를 알면 함께 넘긴다 */
export const summarizeExtract = (
  onConversation: boolean,
  result: Pick<ExtractResult, 'messages' | 'selector' | 'tried' | 'guessedRoles'>,
  emptyBodies?: number,
): ExtractSummary => ({
  onConversation,
  messageCount: result.messages.length,
  selector: result.selector,
  guessedRoles: result.guessedRoles,
  emptyBodies,
  tried: result.tried,
});

// ── 진단 복사 ─────────────────────────────────────────────────
// 전략 이름은 코드에 박힌 짧은 영문 이름이다. 혹시 다른 값이 들어와도 글이 새지 않게 영문·숫자·-_ 만 남기고 자른다
const safeName = (name: unknown) => String(name).replace(/[^\w-]/g, '?').slice(0, 40);

/**
 * 개발자에게 보낼 진단 텍스트. 전략별 개수·판정만 담고 대화 내용·제목·주소·계정 정보는 담지 않는다.
 * 판정은 summary 로 다시 계산한다.
 */
export function formatExtractDiagnostic(summary: ExtractSummary): string {
  const health = assessExtractHealth(summary);
  const tried = (summary.tried ?? []).map((t) => `${safeName(t.name)}=${count(t.count)}`).join(', ');
  const lines = [
    '[싱크업 화면 읽기 진단]',
    `대화 화면: ${summary.onConversation ? '예' : '아니오'}`,
    `읽은 메시지: ${count(summary.messageCount)}개`,
    `먹힌 전략: ${summary.selector ? safeName(summary.selector) : '없음'}`,
    `화자 추정: ${count(summary.guessedRoles)}개`,
    `빈 본문: ${summary.emptyBodies === undefined ? '알 수 없음' : `${count(summary.emptyBodies)}개`}`,
    `전략별 개수: ${tried || '(기록 없음)'}`,
    `판정: ${health.status === 'ok' ? '정상' : `주의 (${health.reasons.map((r) => r.code).join(', ')})`}`,
  ];
  return lines.join('\n');
}
