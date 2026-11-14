// 로컬 수집기 상태를 확장 저장소(설정 · 검토 대기 카드 · 배지)에 옮기고, 팝업에 보일 마지막 오류를 정한다.
import { TURNS_PER_BATCH } from '@shared/batch';
import type { ExtStatus } from '@shared/bridge';
import type { RelatedCard } from '@shared/types';
import { announceCandidates } from './candidate-notice';
import { CollectorUnreachable, errorText, rpc } from './collector-rpc';
import { updateBadge } from './conflict-alerts';
import { collectStateItem, pendingCountItem, settingsFromStatus, settingsItem, shareableCount, type CollectState } from './settings';

// 새로 고침이 성공하면 지우는 오류: 새로 고침 자신의 실패와 수집기에 닿지 못한 실패(unreachable 이 false 로 적히지 않은 것).
// 수집·지금 분류·설정 저장을 수집기가 거절한 오류는 그 요청이 다시 성공할 때까지 남긴다.
const clearedByRefresh = (state: CollectState) => state.op === 'refresh' || state.unreachable !== false;

// 묶음 크기는 기본값으로 고정한다. 예전에 바꿔 저장한 수집기 값이 있으면 기본값으로 되돌린다 (실패해도 상태 읽기는 계속)
async function keepDefaultBatch(status: ExtStatus) {
  if (!status.configured || status.turnsPerBatch === TURNS_PER_BATCH) return;
  await rpc('collection.configure', { turnsPerBatch: TURNS_PER_BATCH }).catch(() => {});
}

// 확장은 검토 대기 "개수"만 쓴다. 후보 본문까지 받는 candidates.list 대신 collection.status 의 counts.reviewPending 을 읽는다
// (수집기 후보는 공유 후보만 만들어진다: batch_classification). counts 가 없는 옛 수집기만 candidates.list 로 센다
async function readStatus(): Promise<{ status: ExtStatus; pending: number }> {
  const status = await rpc<ExtStatus>('collection.status');
  const pending = status?.counts?.reviewPending;
  if (typeof pending === 'number') return { status, pending };
  const result = await rpc<{ cards: RelatedCard[]; status: ExtStatus }>('candidates.list');
  return { status: result.status, pending: shareableCount(result.cards) };
}

export async function refreshStatus() {
  const result = await readStatus();
  await keepDefaultBatch(result.status);
  await settingsItem.setValue(settingsFromStatus(await settingsItem.getValue(), result.status));
  const shareable = result.pending;
  await pendingCountItem.setValue(shareable); // 개수만 저장한다: 카드 본문은 확장 저장소에 남기지 않는다
  const state = await collectStateItem.getValue();
  if (state.lastError && clearedByRefresh(state)) await collectStateItem.setValue({ lastError: null });
  await updateBadge(); // 미해결 충돌이 있으면 빨간 배지로 그 수, 없으면 검토 대기 수 (lib/conflict-alerts.ts)
  await announceCandidates(shareable); // 검토할 카드가 늘었으면 시스템 알림 (던지지 않는다. lib/candidate-notice.ts)
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
