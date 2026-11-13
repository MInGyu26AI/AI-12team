// 팀 기록 불러오기: 팀 보드를 웹의 "팀 기록 복사"와 같은 마크다운으로 만들고 ChatGPT 입력창에 채운다.
// 전송은 사용자가 직접 한다. 입력창을 못 찾거나 못 채우면 클립보드에 복사한다.
// 팀 보드 데이터를 받는 방법(백그라운드 → 로컬 수집기 team.board·team.conflicts)은 이 파일이 모른다: 받는 함수를 주입받는다.
import { boardToMarkdown } from '@shared/board-markdown';
import type { Conflict, RelatedCard } from '@shared/types';

export interface TeamRecordData {
  cards: RelatedCard[]; // team.board 의 items (웹 real.ts getBoard 와 같은 값)
  conflicts: Conflict[]; // team.conflicts 의 conflicts
}

/** 팀 보드 카드와 처리 안 된 충돌을 받아 온다. 실패는 사용자에게 보일 문구를 담은 Error 로 던진다 */
export type TeamRecordSource = () => Promise<TeamRecordData>;

export type TeamRecordLoad = { ok: true; markdown: string; cardCount: number } | { ok: false; error: string };

export const EMPTY_RECORD_GUIDE = '팀 결정 기록이 아직 없어요. 개인 검토함에서 카드를 승인하면 불러올 수 있어요';
const LOAD_FAIL_GUIDE = '팀 기록을 불러오지 못했어요';

export async function loadTeamRecord(source: TeamRecordSource): Promise<TeamRecordLoad> {
  let data: TeamRecordData;
  try {
    data = await source();
  } catch (error) {
    return { ok: false, error: (error instanceof Error && error.message) || LOAD_FAIL_GUIDE };
  }
  if (!Array.isArray(data?.cards)) return { ok: false, error: LOAD_FAIL_GUIDE };
  if (!data.cards.length) return { ok: false, error: EMPTY_RECORD_GUIDE };
  return { ok: true, markdown: boardToMarkdown(data.cards, Array.isArray(data.conflicts) ? data.conflicts : []), cardCount: data.cards.length };
}

// ChatGPT 입력창: 지금은 ProseMirror 편집기(div#prompt-textarea, contenteditable)이고, 예전 화면은 textarea 다.
// 실제 chatgpt.com 에서 확인하지 못했으므로 여러 후보를 순서대로 본다. lib/sites/chatgpt.ts 의 메시지 감지 규칙과는 따로 둔다.
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'form div.ProseMirror[contenteditable="true"]',
  'form textarea',
  '[contenteditable="true"][role="textbox"]',
];

function isUsable(el: HTMLElement): boolean {
  if (el.closest('#syncup-root, [hidden], [aria-hidden="true"]')) return false;
  if (el.tagName === 'TEXTAREA' && ((el as HTMLTextAreaElement).disabled || (el as HTMLTextAreaElement).readOnly)) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}

export function findComposer(root: Document = document): HTMLElement | null {
  for (const selector of COMPOSER_SELECTORS) {
    const found = [...root.querySelectorAll<HTMLElement>(selector)].find(isUsable);
    if (found) return found;
  }
  return null;
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** 넣은 글이 입력창에 실제로 들어갔는지: 내용이 바뀌었고 첫 줄과 끝 줄이 모두 보인다 */
function landed(el: HTMLElement, before: string, text: string): boolean {
  const content = squash(el.textContent ?? '');
  const lines = text.split('\n').map(squash).filter(Boolean);
  const first = lines[0];
  const last = lines[lines.length - 1];
  return first !== undefined && last !== undefined && content !== before && content.includes(first) && content.includes(last);
}

function placeCaretAtEnd(el: HTMLElement) {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

// 붙여넣기 이벤트로 넣는다: ProseMirror 가 줄마다 문단으로 받는다. 편집기가 직접 처리하면(기본 동작을 막으면) true
function dispatchPaste(el: HTMLElement, text: string): boolean {
  try {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    return !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  } catch {
    return false;
  }
}

function fillEditable(el: HTMLElement, text: string): boolean {
  el.focus();
  placeCaretAtEnd(el);
  const before = squash(el.textContent ?? '');
  // 쓰던 글이 있으면 지우지 않고 그 뒤에 빈 줄을 두고 잇는다
  const payload = before ? `\n\n${text}` : text;
  dispatchPaste(el, payload);
  if (landed(el, before, text)) return true;
  // 편집기가 붙여넣기를 받지 않으면 입력 명령으로 한 번 더 시도한다 (붙여넣기가 이미 들어갔다면 위에서 끝난다)
  const doc = el.ownerDocument;
  const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, payload);
  return !!inserted && landed(el, before, text);
}

// React 가 값을 추적하는 textarea 는 인스턴스의 value 대신 원형의 setter 로 넣고 input 이벤트를 보내야 상태가 따라온다
function fillTextarea(el: HTMLTextAreaElement, text: string): boolean {
  const next = el.value.trim() ? `${el.value.replace(/\s+$/, '')}\n\n${text}` : text;
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setValue) setValue.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(next.length, next.length);
  return el.value === next;
}

/** 입력창에 글을 넣는다. 쓰던 글은 지우지 않고 뒤에 잇는다. 입력창이 없거나 들어갔는지 확인하지 못하면 false */
export function fillComposer(text: string, root: Document = document): boolean {
  const el = findComposer(root);
  if (!el) return false;
  return el.tagName === 'TEXTAREA' ? fillTextarea(el as HTMLTextAreaElement, text) : fillEditable(el, text);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type DeliverResult = 'filled' | 'copied' | 'failed';

/** 입력창에 채우고, 안 되면 클립보드에 복사한다. 전송은 하지 않는다 */
export async function deliverTeamRecord(markdown: string, root: Document = document): Promise<DeliverResult> {
  if (fillComposer(markdown, root)) return 'filled';
  return (await copyText(markdown)) ? 'copied' : 'failed';
}
