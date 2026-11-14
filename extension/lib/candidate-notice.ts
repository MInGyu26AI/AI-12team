// 새 후보 알림 (기능 C): 검토할 공유 후보가 늘면 시스템 알림 "검토할 카드 N개"를 띄운다.
// 알림 문구에는 카드 내용을 넣지 않는다(개수만). 누르면 개인 검토함(/review)을 연다.
// browser API 는 인자로 주입할 수 있어 시험에서 가짜로 바꾼다. 알림 실패는 삼킨다:
// 알림은 덤이라, 이 때문에 상태 새로 고침(배지 · 팝업 오류)이 실패로 기록되면 안 된다.
import { storage } from '#imports';
import { settingsItem, type Settings } from './settings';
import { webUrlOf } from './web-url';

/** 알림 id 를 하나로 고정한다: 겹쳐 새로 고쳐져도 알림이 쌓이지 않고 같은 알림이 갱신된다 */
export const NOTICE_ID = 'syncup-new-candidates';
const NOTICE_TITLE = '싱크업';
const NOTICE_ICON = '/icon/128.png';

export const noticeText = (count: number) => `검토할 카드 ${count}개`;
export const reviewUrl = (settings: Pick<Settings, 'webUrl'>) => `${webUrlOf(settings)}/review`;

/** 이 파일이 쓰는 browser API 만 추린 모양. 시험에서는 가짜를 넣는다 */
export interface NoticeBrowser {
  notifications: {
    create(id: string, options: { type: 'basic'; iconUrl: string; title: string; message: string }): unknown;
    clear(id: string): unknown;
    onClicked: { addListener(listener: (id: string) => void): void };
  };
  tabs: { create(properties: { url: string }): unknown };
  runtime: { getURL(path: string): string };
}

/**
 * 알릴 카드 수. 알릴 일이 없으면 null.
 * - previous 가 null 이면 처음 본 값이라 알리지 않는다 (설치 직후 · 처음 시작)
 * - 늘었을 때만 알린다. 같거나 줄면 알리지 않는다
 */
export const newCandidateCount = (previous: number | null, current: number): number | null =>
  previous !== null && current > previous ? current : null;

/** previous → current 로 늘었으면 알림을 띄운다. 띄웠으면 true */
export async function notifyNewCandidates(previous: number | null, current: number, api: NoticeBrowser = browser): Promise<boolean> {
  const count = newCandidateCount(previous, current);
  if (count === null) return false;
  try {
    await api.notifications.create(NOTICE_ID, {
      type: 'basic',
      iconUrl: api.runtime.getURL(NOTICE_ICON),
      title: NOTICE_TITLE,
      message: noticeText(count),
    });
    return true;
  } catch {
    return false; // 알림 권한이 꺼져 있거나 OS 가 막은 경우
  }
}

// 마지막으로 본 공유 후보 수. pendingItem 의 기본값([])으로는 "처음 봄"과 "0개"를 가를 수 없어 따로 둔다 (null = 아직 본 적 없음)
export const noticeBaselineItem = storage.defineItem<number | null>('local:candidateNoticeBaseline', { fallback: null });

/**
 * 상태를 새로 고칠 때마다 현재 공유 후보 수로 부른다: 지난번 수와 비교해 알리고, 이번 수를 기억한다.
 * 알림이 실패해도 기억은 갱신한다(30초마다 같은 실패를 되풀이하지 않는다). 절대 던지지 않는다.
 */
export async function announceCandidates(current: number, api: NoticeBrowser = browser): Promise<boolean> {
  try {
    const previous = await noticeBaselineItem.getValue();
    await noticeBaselineItem.setValue(current);
    return await notifyNewCandidates(previous, current, api);
  } catch {
    return false;
  }
}

/** 알림을 눌렀을 때: 개인 검토함을 열고 알림을 지운다 */
export async function onNoticeClicked(id: string, api: NoticeBrowser = browser): Promise<void> {
  if (id !== NOTICE_ID) return;
  try {
    await api.tabs.create({ url: reviewUrl(await settingsItem.getValue()) });
    await api.notifications.clear(NOTICE_ID);
  } catch {
    // 탭을 못 열면 알림은 그대로 둔다: 사용자가 다시 누를 수 있다
  }
}

/** 백그라운드 최상위에서 한 번 부른다 (서비스 워커가 깨어날 때마다 리스너가 다시 붙어야 하므로 비동기 작업 뒤가 아니라 첫 동기 구간에서) */
export function listenNoticeClick(api: NoticeBrowser = browser): void {
  api.notifications.onClicked.addListener((id) => void onNoticeClicked(id, api));
}
