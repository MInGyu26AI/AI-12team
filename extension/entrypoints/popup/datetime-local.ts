// Date ↔ <input type="datetime-local"> 값 (브라우저 지역 시간)
const pad = (n: number) => String(n).padStart(2, '0');

export const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 입력값 → ISO. 비어 있으면(다 입력하기 전에도 빈 값이다) null: 수집기는 종료 시각 지우기를 받지 않는다 */
export const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);
