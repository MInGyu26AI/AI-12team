// 팝업이 백그라운드에 보내는 동기화 요청 (docs/sync-contract.md 5장). 켬·끔은 syncSet, 싱크 맞추기는 syncNow
import type { SyncNowResult } from '@shared/bridge';
import type { SyncState } from '@/lib/chatgpt-sync/state';
import { sendToBackground, type BgRequest, type SyncProject } from '@/lib/messages';
import { syncNowNotice, type PopupNotice } from './sync-status';

export type SyncSetResult = { ok: true; state: SyncState | null } | { ok: false; error: string };

/** '프로젝트만 수집' 켜기·끄기. 켜는 데 실패하면 백그라운드가 준 문구를 그대로 돌려준다 */
export async function setProjectSync(enabled: boolean, project?: SyncProject): Promise<SyncSetResult> {
  const request: BgRequest = enabled ? { type: 'syncSet', enabled, project } : { type: 'syncSet', enabled };
  const response = await sendToBackground(request).catch(() => null);
  if (!response?.ok) return { ok: false, error: response?.error ?? '동기화 설정을 바꾸지 못했어요' };
  return { ok: true, state: (response.result as SyncState | undefined) ?? null };
}

/** '싱크 맞추기': 동기화 패스를 바로 한 번 돌리고 쌓인 대화를 분류에 보낸다 */
export async function runSyncNow(): Promise<PopupNotice> {
  const response = await sendToBackground({ type: 'syncNow', params: { reason: 'button' } }).catch(() => null);
  if (!response?.ok) return { tone: 'error', text: response?.error ?? '싱크 맞추기 요청이 실패했어요' };
  const result = response.result as SyncNowResult | undefined;
  if (!result) return { tone: 'error', text: '싱크 맞추기 결과를 받지 못했어요' };
  return syncNowNotice(result);
}
