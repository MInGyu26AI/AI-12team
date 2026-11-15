// Date ↔ 날짜와 시각 입력에 쓰는 값 (브라우저 지역 시간)
const pad = (n: number) => String(n).padStart(2, '0');
const minuteMs = 60_000;
export const HOUR_MS = 60 * minuteMs;
export const MAX_COLLECTION_DAYS = 7;
export const MAX_COLLECTION_MS = MAX_COLLECTION_DAYS * 24 * HOUR_MS;

export const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 입력값 → ISO. 존재하지 않는 날짜나 지역 시각에는 값을 보내지 않는다. */
export function fromLocalInput(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && toLocalInput(date) === value ? date.toISOString() : null;
}

export function deadlineCalendar(now: number) {
  const minute = Math.floor(now / minuteMs) * minuteMs;
  const first = toLocalInput(new Date(minute + minuteMs));
  const last = toLocalInput(new Date(minute + MAX_COLLECTION_MS));
  const day = new Date(first.slice(0, 10) + 'T12:00');
  const days = [];
  for (let date = toLocalInput(day).slice(0, 10); date <= last.slice(0, 10); date = toLocalInput(day).slice(0, 10)) {
    days.push({ date, day: day.getDate(), month: day.getMonth() + 1, weekday: '일월화수목금토'[day.getDay()] });
    day.setDate(day.getDate() + 1);
  }
  return { first, last, days };
}
