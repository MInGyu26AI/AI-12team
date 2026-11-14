// 화면 구조 변경 감지의 배지 쪽 (기능 A): 열려 있는 채팅 탭에 ping 을 보내 화면 읽기가 정상인지 보고,
// 이상이 이어지면 그 탭에서만 확장 배지에 `!` 를 띄운다. 백그라운드가 30초 알람마다 부른다.
// - 탭 단위 배지라 전역 배지(검토 대기 수, collector-status.ts)를 덮어쓰지 않고, 그 탭을 벗어나면 숫자가 보인다.
// - 화면을 막 열었거나 대화를 바꾼 직후에는 0건이 정상이라, 경고가 CONFIRM_POLLS 번 연이어 나와야 `!` 를 건다.
// - 판정은 lib/extract-health.ts, 이 파일은 탭 조회 · 상태 기억 · 배지만 맡는다. 대화 내용은 오가지 않는다(ping 에는 개수뿐).
import { storage } from '#imports';
import { assessExtractHealth } from './extract-health';
import type { TabPing, TabPingResult } from './messages';
import { CHAT_PAGE_MATCHES } from './sites';

export const WARN_BADGE_TEXT = '!';
export const WARN_BADGE_COLOR = '#D97706'; // 변경·주의에 쓰는 주황빛 (shared/theme.css)
export const CONFIRM_POLLS = 2; // 연이어 이만큼 경고여야 배지를 건다 (30초 간격이면 약 30~60초 뒤)
export const PING_TIMEOUT_MS = 5000; // 멈춘 탭 하나가 전체 점검을 붙잡지 않게

interface TabHealthState {
  streak: number; // 연이은 경고 횟수
  flagged: boolean; // 배지를 걸었는지
}

// 서비스 워커는 30초마다 잠들어 메모리가 비므로 세션 저장소(브라우저를 닫으면 사라짐)에 둔다. 키는 탭 id
export const tabHealthItem = storage.defineItem<Record<string, TabHealthState>>('session:tabHealth', { fallback: {} });

/** 이 파일이 쓰는 browser API 만 추린 모양. 시험에서는 가짜를 넣는다 */
export interface TabHealthApi {
  tabs: {
    query(info: { url: string[] }): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: TabPing): Promise<unknown>;
  };
  action: {
    setBadgeText(details: { tabId: number; text: string | null }): unknown;
    setBadgeBackgroundColor(details: { tabId: number; color: string }): unknown;
  };
}

const isPingResult = (value: unknown): value is TabPingResult =>
  !!value && typeof value === 'object' && typeof (value as TabPingResult).onConversation === 'boolean';

/** 탭이 답한 ping. 콘텐츠 스크립트가 없거나(설치 전에 열린 탭 · 확장을 새로 고친 뒤) 답이 없으면 null */
async function pingTab(api: TabHealthApi, tabId: number): Promise<TabPingResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), PING_TIMEOUT_MS)));
  try {
    const answer = await Promise.race([api.tabs.sendMessage(tabId, { type: 'ping' }), timeout]);
    return isPingResult(answer) ? answer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 한 탭의 다음 상태. 답이 없으면(ping == null) 아무것도 바꾸지 않는다: 모르는 것을 정상이나 이상으로 단정하지 않는다.
 */
export function nextTabHealth(previous: TabHealthState, ping: TabPingResult | null, confirmPolls = CONFIRM_POLLS): TabHealthState {
  if (!ping) return previous;
  if (assessExtractHealth(ping).status === 'ok') return { streak: 0, flagged: false };
  const streak = previous.streak + 1;
  return { streak, flagged: streak >= confirmPolls };
}

/** 열려 있는 채팅 탭을 모두 점검해 배지를 맞춘다. 던지지 않는다 */
export async function checkChatTabs(api: TabHealthApi = browser as unknown as TabHealthApi): Promise<void> {
  try {
    const tabs = (await api.tabs.query({ url: CHAT_PAGE_MATCHES })).filter((t): t is { id: number } => t.id !== undefined);
    const previous = await tabHealthItem.getValue();
    const entries = await Promise.all(
      tabs.map(async ({ id }): Promise<[string, TabHealthState]> => {
        const before = previous[id] ?? { streak: 0, flagged: false };
        const after = nextTabHealth(before, await pingTab(api, id));
        // 배지는 전체 새로 고침이나 이동으로 사라질 수 있어, 걸려 있어야 하는 동안은 점검마다 다시 건다
        if (after.flagged) {
          await api.action.setBadgeText({ tabId: id, text: WARN_BADGE_TEXT });
          await api.action.setBadgeBackgroundColor({ tabId: id, color: WARN_BADGE_COLOR });
        } else if (before.flagged) {
          await api.action.setBadgeText({ tabId: id, text: null }); // 탭 단위 값을 지워 전역 배지로 돌아간다
        }
        return [String(id), after];
      }),
    );
    await tabHealthItem.setValue(Object.fromEntries(entries)); // 닫힌 탭의 기록은 여기서 빠진다
  } catch {
    // 배지는 덤이다: 점검 실패가 상태 새로 고침이나 팝업 오류로 번지면 안 된다
  }
}
