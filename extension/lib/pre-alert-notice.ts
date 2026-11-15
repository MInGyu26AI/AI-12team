// 승인 전 미리 알림 (shared/pre-alert.ts): 검토 중 후보가 같은 세부 주제의 팀 결정과 어긋나면 본인에게 시스템 알림을 띄운다.
// collection.status 의 preAlerts 를 읽는다. 들어 있는 것은 팀 결정(이미 팀 보드에 공유된 내용)과 묶음 키뿐이고 후보 문장은 없다.
// 같은 key 는 한 번만 알린다: 두 대화에서 나온 같은 결정, 새로 고침마다 다시 보이는 알림. 팀에는 아무것도 보내지 않는다.
// browser API 는 인자로 주입할 수 있어 시험에서 가짜로 바꾼다. 알림 실패는 삼킨다 (candidate-notice.ts 와 같다).
import { storage } from '#imports';
import { preAlertText, type PreAlertSummary } from '@shared/pre-alert';
import { reviewUrl, type NoticeBrowser } from './candidate-notice';
import { settingsItem } from './settings';

export const PRE_ALERT_NOTICE_ID = 'syncup-pre-alerts';
const MAX_REMEMBERED = 500;

// 지금 검토 중인 미리 알림 (팝업 표시) · 이미 알린 key (오래된 것부터 밀어냄)
export const preAlertsItem = storage.defineItem<PreAlertSummary[]>('local:preAlerts', { fallback: [] });
export const notifiedPreAlertsItem = storage.defineItem<string[]>('local:notifiedPreAlerts', { fallback: [] });

/** 알림 문구. 한 건이면 그 팀 결정을, 여러 건이면 건수를 */
export function preAlertNotice(fresh: PreAlertSummary[]) {
  const [first] = fresh;
  if (fresh.length === 1 && first) return { title: `싱크업 미리 알림: ${first.topicKey}`, message: preAlertText(first) };
  return { title: '싱크업 미리 알림', message: `팀 결정과 어긋나는 후보 ${fresh.length}건이 있어요. 승인 전에 확인해 주세요.` };
}

/**
 * 상태를 새로 고칠 때마다 부른다: 팝업용 목록을 바꾸고, 처음 보는 key 만 알린다. 띄웠으면 true. 절대 던지지 않는다.
 * alerts 가 없으면(옛 수집기) 빈 목록으로 본다.
 */
export async function announcePreAlerts(alerts: PreAlertSummary[] | undefined, api: NoticeBrowser = browser): Promise<boolean> {
  try {
    const current = alerts ?? [];
    await preAlertsItem.setValue(current);
    const notified = await notifiedPreAlertsItem.getValue();
    const fresh = current.filter((a) => !notified.includes(a.key));
    if (!fresh.length) return false;
    // 알림이 실패해도 기억한다: 30초마다 같은 실패를 되풀이하지 않는다
    await notifiedPreAlertsItem.setValue([...notified, ...fresh.map((a) => a.key)].slice(-MAX_REMEMBERED));
    await api.notifications.create(PRE_ALERT_NOTICE_ID, {
      type: 'basic',
      iconUrl: api.runtime.getURL('/icon/128.png'),
      ...preAlertNotice(fresh),
    });
    return true;
  } catch {
    return false; // 알림 권한이 꺼져 있거나 OS 가 막은 경우
  }
}

/** 알림을 누르면 개인 검토함(/review)을 열고 알림을 지운다 */
export async function onPreAlertClicked(id: string, api: NoticeBrowser = browser): Promise<void> {
  if (id !== PRE_ALERT_NOTICE_ID) return;
  try {
    await api.tabs.create({ url: reviewUrl(await settingsItem.getValue()) });
    await api.notifications.clear(PRE_ALERT_NOTICE_ID);
  } catch {
    // 탭을 못 열면 알림은 그대로 둔다
  }
}

/** 백그라운드 최상위의 첫 동기 구간에서 한 번 부른다 (candidate-notice.ts listenNoticeClick 과 같은 이유) */
export function listenPreAlertClick(api: NoticeBrowser = browser): void {
  api.notifications.onClicked.addListener((id) => void onPreAlertClicked(id, api));
}
