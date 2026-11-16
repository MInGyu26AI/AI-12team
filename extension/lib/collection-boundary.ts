// Drain completed/current replies before the local collector rejects new appends.
import type { TabCancelStop, TabPrepareStop, TabStopResult } from './messages';
import type { ExtSettingsPatch } from '@shared/bridge';
import { rpc } from './collector-rpc';
import { refreshStatus } from './collector-status';
import { isSyncedProjectPage } from './chatgpt-sync/scheduler';
import { collectionTransitionItem, settingsItem } from './settings';
import { CHAT_PAGE_MATCHES } from './sites';

let changing = false;
const TIMEOUT_MS = 65_000;
async function finishTab(id: number): Promise<TabStopResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(id, { type: 'collection.prepareStop' } satisfies TabPrepareStop),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('마지막 답변 저장 확인 시간 초과')), TIMEOUT_MS); }),
    ]) as TabStopResult | undefined;
    return response?.ok === true || (response?.ok === false && typeof response.error === 'string')
      ? response : { ok: false, error: '열린 ChatGPT 탭의 수집기를 갱신하려면 페이지를 새로고침해 주세요.' };
  } catch {
    return { ok: false, error: 'ChatGPT 탭에 연결할 수 없어 마지막 답변 저장을 확인하지 못했어요.' };
  } finally { clearTimeout(timer); }
}

export async function configureCollection(patch: ExtSettingsPatch | Record<string, unknown>) {
  if (typeof patch?.autoCollect !== 'boolean') return rpc('collection.configure', patch);
  if (changing) throw new Error('수집 상태를 바꾸는 중이에요. 잠시 기다려 주세요.');
  changing = true;
  const failures: string[] = [];
  const stopped: number[] = [];
  try {
    await collectionTransitionItem.setValue(patch.autoCollect ? 'starting' : 'stopping');
    if (!patch.autoCollect && (await settingsItem.getValue()).autoCollect) {
      const tabs = await browser.tabs.query({ url: CHAT_PAGE_MATCHES });
      await Promise.all(tabs.map(async (tab) => {
        if (tab.id === undefined || await isSyncedProjectPage(tab.url)) return;
        stopped.push(tab.id);
        const result = await finishTab(tab.id);
        if (!result.ok) failures.push(result.error);
      }));
    }
    const result = await rpc('collection.configure', patch).catch(async (error) => {
      // 끄지 못했으면 설정은 계속 켜져 있다. 중지 대기로 멈춘 탭이 다시 보내게 한다
      await Promise.all(stopped.map((id) => browser.tabs.sendMessage(id, { type: 'collection.cancelStop' } satisfies TabCancelStop).catch(() => {})));
      throw error;
    });
    await refreshStatus();
    // OFF still takes effect if a tab closed or a save failed. Never report that as a successful drain.
    if (failures.length) throw new Error(`수집은 껐지만 ${failures.length}개 탭의 마지막 저장을 확인하지 못했어요. ${failures[0]}`);
    return result;
  } finally {
    await collectionTransitionItem.setValue(null);
    changing = false;
  }
}
