// 팝업에 쓰는 시각 표시 (브라우저 지역 시간)
const pad = (n: number) => String(n).padStart(2, '0');

/** "방금 전" · "3분 전" · "2시간 전" · "4일 전". 읽을 수 없는 시각이나 미래 시각은 "방금 전" */
export function formatAgo(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (!(diff >= 60_000)) return '방금 전';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** "14:30". 오늘이 아니면 날짜를 붙여 "11/14 01:30". 읽을 수 없는 시각은 빈 문자열 */
export function formatClock(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}
