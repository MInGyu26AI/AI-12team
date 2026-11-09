// 로컬 수집기 상태를 확장 저장소(설정 · 검토 대기 카드 · 배지)에 옮기고, 팝업에 보일 마지막 오류를 정한다.
import type { ExtStatus } from '@shared/bridge';
import type { RelatedCard } from '@shared/types';
import { CollectorUnreachable, errorText, rpc } from './collector-rpc';
import { collectStateItem, pendingItem, settingsFromStatus, settingsItem, shareableCount, type CollectState } from './settings';

// 새로 고침이 성공하면 지우는 오류: 새로 고침 자신의 실패와 수집기에 닿지 못한 실패(unreachable 이 false 로 적히지 않은 것).
// 수집·지금 분류·설정 저장을 수집기가 거절한 오류는 그 요청이 다시 성공할 때까지 남긴다.
const clearedByRefresh = (state: CollectState) => state.op === 'refresh' || state.unreachable !== false;

export async function refreshStatus() {
  const result = await rpc<{ cards: RelatedCard[]; status: ExtStatus }>('candidates.list');
  await settingsItem.setValue(settingsFromStatus(await settingsItem.getValue(), result.status));
  await pendingItem.setValue(result.cards);
  const state = await collectStateItem.getValue();
  if (state.lastError && clearedByRefresh(state)) await collectStateItem.setValue({ lastError: null });
  const shareable = shareableCount(result.cards);
  await browser.action.setBadgeText({ text: shareable ? String(shareable) : '' });
  return result;
}

export async function recordFailure(error: unknown, op: CollectState['op'] = 'request') {
  const message = errorText(error);
  await collectStateItem.setValue({ lastError: message, unreachable: error instanceof CollectorUnreachable, op });
  return { ok: false as const, error: message };
}

/** 주기적 새로 고침처럼 실패를 돌려줄 곳이 없을 때: 실패를 팝업 오류로만 남긴다 */
export const refreshStatusOrRecordFailure = () => refreshStatus().catch((error) => recordFailure(error, 'refresh'));

export const clearError = () => collectStateItem.setValue({ lastError: null });

// 요청 자체가 성공하면 이전 오류를 지우고, 뒤따르는 새로 고침의 실패는 기록만 한다 (요청 결과는 성공 그대로)
export async function clearErrorAndRefresh() {
  await clearError();
  await refreshStatusOrRecordFailure();
}
