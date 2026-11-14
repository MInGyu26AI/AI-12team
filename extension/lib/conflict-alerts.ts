// 1분마다 로컬 수집기 RPC team.conflicts 로 팀의 미해결 충돌을 확인해, 새로 생긴 것만 시스템 알림(윈도우·맥)으로 알리고
// 아이콘 배지에 미해결 수를 띄운다. 이미 알린 충돌은 다시 알리지 않고, 수집기에 닿지 못하면 조용히 건너뛴다.
import { storage } from '#imports';
import { ALERT_LEVEL, alertLevel } from '@shared/labels';
import type { Conflict } from '@shared/types';
import { rpc } from './collector-rpc';
import { pendingCountItem, settingsItem } from './settings';
import { webUrlOf } from './web-url';

export const CONFLICT_ALARM = 'conflicts';
export const CONFLICT_NOTIFICATION = 'syncup-conflicts';
const MAX_REMEMBERED = 500;

// 이미 알린 충돌 id (오래된 것부터 밀어냄) · 마지막으로 확인한 미해결 충돌 수 (배지)
export const notifiedConflictsItem = storage.defineItem<string[]>('local:notifiedConflicts', { fallback: [] });
export const openConflictCountItem = storage.defineItem<number>('local:openConflictCount', { fallback: 0 });

/** 배지: 미해결 충돌이 있으면 빨간 배지로 그 수, 없으면 검토 대기 카드 수 */
export async function updateBadge() {
  const conflicts = await openConflictCountItem.getValue();
  const pending = await pendingCountItem.getValue();
  try {
    await browser.action.setBadgeBackgroundColor({ color: conflicts ? '#c62828' : '#4f46e5' });
  } catch {
    // 색을 못 바꾸는 환경이어도 숫자는 띄운다
  }
  const count = conflicts || pending;
  await browser.action.setBadgeText({ text: count ? String(count) : '' });
}

// "충돌: MVP 범위" / "팀 결정 알림 2건"
function notificationOf(fresh: Conflict[]) {
  const [x] = fresh;
  if (fresh.length === 1 && x) {
    return { title: `싱크업 ${ALERT_LEVEL[alertLevel(x)].label}: ${x.topic_key}`, message: `새 결정 "${x.cardB.content}" · 기존 "${x.cardA.content}"` };
  }
  const topics = [...new Set(fresh.map((x) => x.topic_key))].join(', ');
  return { title: `싱크업 팀 결정 알림 ${fresh.length}건`, message: `확인할 주제: ${topics}` };
}

export async function checkConflicts() {
  let conflicts: Conflict[];
  try {
    conflicts = (await rpc<{ conflicts: Conflict[] }>('team.conflicts')).conflicts;
  } catch {
    return; // 수집기 연결이 없거나 팀에 접근할 수 없으면 조용히 건너뛴다 (팝업 오류는 상태 새로 고침이 알린다)
  }
  const open = conflicts.filter((x) => !x.resolution || x.resolution === 'discuss');
  await openConflictCountItem.setValue(open.length);
  await updateBadge();

  const notified = await notifiedConflictsItem.getValue();
  const fresh = open.filter((x) => !notified.includes(x.id));
  if (!fresh.length) return;
  await notifiedConflictsItem.setValue([...notified, ...fresh.map((x) => x.id)].slice(-MAX_REMEMBERED));
  await browser.notifications.create(CONFLICT_NOTIFICATION, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    priority: 1,
    ...notificationOf(fresh),
  });
}

/** 알림을 누르면 팀 보드(/board)를 연다 */
export async function openBoardFromNotification(id: string) {
  if (id !== CONFLICT_NOTIFICATION) return;
  await browser.tabs.create({ url: `${webUrlOf(await settingsItem.getValue())}/board` });
  await browser.notifications.clear(id);
}
