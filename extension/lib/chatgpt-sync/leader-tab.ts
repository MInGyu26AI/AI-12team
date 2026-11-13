// 동기화 요청을 보낼 대표 chatgpt.com 탭 고르기 (docs/sync-contract.md 5장 "대표 탭").
// 한 패스는 한 탭에서만 돈다. 탭이 답하지 않거나 채널이 닫히면 그 요청은 'network' 다
import type { TabSyncRequest, TabSyncResult } from '../messages';
import { SYNC_TAB_TIMEOUT_MS } from './state';

const CHATGPT_TABS = ['https://chatgpt.com/*'];

// 마지막으로 답한 탭. 서비스 워커가 다시 뜨면 잊지만 고르는 순서의 힌트일 뿐이다
let lastRespondedTabId: number | null = null;

export interface LeaderTab {
  readonly tabId: number;
  /** 이 탭이 답하지 않았거나 채널이 닫혔음. 패스는 남은 대화를 다음 패스로 미룬다 */
  readonly lost: boolean;
  request<T>(request: TabSyncRequest): Promise<TabSyncResult<T>>;
}

const NETWORK = { ok: false, error: 'network' } as const;

const isTabResult = (value: unknown): value is TabSyncResult<unknown> =>
  !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean';

/** 탭 하나에 요청을 보낸다. 시간 제한·응답 없음·채널 닫힘·이상한 응답이면 null */
async function sendToTab<T>(tabId: number, request: TabSyncRequest): Promise<TabSyncResult<T> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), SYNC_TAB_TIMEOUT_MS)));
  try {
    const response = await Promise.race([browser.tabs.sendMessage(tabId, request).catch(() => null), timeout]);
    if (!isTabResult(response)) return null;
    lastRespondedTabId = tabId;
    return response as TabSyncResult<T>;
  } finally {
    clearTimeout(timer);
  }
}

/** 활성 탭 → 마지막으로 답한 탭 → 나머지 순. 폐기·얼린 탭은 답하지 않으므로 뺀다 */
async function candidateTabIds(): Promise<number[]> {
  const tabs = await browser.tabs.query({ url: CHATGPT_TABS });
  const usable = tabs.filter((tab) => tab.id != null && !tab.discarded && !(tab as { frozen?: boolean }).frozen);
  const rank = (tab: (typeof usable)[number]) => (tab.active ? 0 : tab.id === lastRespondedTabId ? 1 : 2);
  return usable.sort((a, b) => rank(a) - rank(b)).map((tab) => tab.id!);
}

function leaderFor(tabId: number): LeaderTab {
  let lost = false;
  return {
    tabId,
    get lost() {
      return lost;
    },
    async request<T>(request: TabSyncRequest) {
      if (lost) return NETWORK;
      const response = await sendToTab<T>(tabId, request);
      if (response) return response;
      lost = true;
      return NETWORK;
    },
  };
}

/**
 * 첫 요청(보통 sync.session)에 답하는 탭을 찾아 대표 탭으로 삼는다. 답하는 탭이 없으면 null (= no_tab).
 * 탭이 답했으면 오류 응답이라도 그 탭이 대표다 (탭이 ChatGPT 에 닿지 못한 'network' 는 탭 없음과 다르다)
 */
export async function findLeaderTab<T>(first: TabSyncRequest): Promise<{ leader: LeaderTab; response: TabSyncResult<T> } | null> {
  for (const tabId of await candidateTabIds()) {
    const response = await sendToTab<T>(tabId, first);
    if (response) return { leader: leaderFor(tabId), response };
  }
  return null;
}

/** 시험용: 모듈 상태 지우기 */
export function resetLeaderTabMemory() {
  lastRespondedTabId = null;
}
