// ChatGPT 화면 읽기 점검용: 글이 비어 메시지로 세지 않은 요소가 몇 개인지.
// lib/sites/chatgpt.ts 는 글이 없는 요소를 ExtractResult 에 넣기 전에 걸러서(tried 의 count 도 그 뒤 수) 빈 본문 수를 알 수 없다.
// 그래서 먹힌 전략의 셀렉터(SELECTORS.strategies, 읽기만 한다)로 요소를 다시 세고, 걸러지고 남은 수(tried)를 뺀다.
// 글을 읽는 규칙(머리말 제거 등)은 따라 하지 않고 chatgpt.ts 의 판정 결과를 그대로 쓴다.
// 대화 안내 문구(NOTICE_TEXT)만 있는 요소도 같이 빠지지만, 그런 화면은 로그아웃 상태라 경고가 맞다.
import { SELECTORS } from './chatgpt';
import type { ExtractResult } from './types';

/** 모르면 undefined: 못 읽었거나(selector null), 셀렉터가 없는 전략(repeated-blocks)이 먹었을 때 */
export function countEmptyBodies(result: Pick<ExtractResult, 'selector' | 'tried'>, root: ParentNode = document): number | undefined {
  const strategy = SELECTORS.strategies.find((s) => s.name === result.selector);
  if (!strategy) return undefined;
  const counted = result.tried.find((t) => t.name === strategy.name)?.count ?? 0;
  const nodes = [...root.querySelectorAll<HTMLElement>(strategy.selector)];
  // chatgpt.ts 의 outermost 와 같은 규칙: 다른 후보 안에 든 요소는 세지 않고, 알림 영역 안은 뺀다
  const elements = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)) && !n.closest(SELECTORS.notice));
  return Math.max(0, elements.length - counted);
}
