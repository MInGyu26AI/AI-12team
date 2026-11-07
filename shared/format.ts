// 카드 표시용 도우미. 시각은 출력 형식의 source("ChatGPT, 2026-11-06 21:10")에서 읽는다.

export interface SourceInfo {
  label: string; // "ChatGPT 대화"
  at: Date | null;
}

export function parseSource(source: string): SourceInfo {
  const m = source.match(/^(.*?),\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/);
  if (!m) return { label: source, at: null };
  const name = m[1]!.trim();
  const at = new Date(`${m[2]}T${(m[3] ?? "00:00").padStart(5, "0")}:00`);
  const label = /^(ChatGPT|Claude|Gemini|Codex|Claude Code)$/i.test(name) ? `${name} 대화` : name;
  return { label, at: Number.isNaN(at.getTime()) ? null : at };
}

const p2 = (n: number) => String(n).padStart(2, "0");
export const fmtMD = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
export const fmtHM = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export const fmtMDHM = (d: Date) => `${fmtMD(d)} ${fmtHM(d)}`;

/** "2026-11-07" → "11/7" */
export const fmtDue = (due: string) => {
  const [, m, d] = due.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : due;
};

/** 시각 순서 비교용 (시각이 없으면 맨 앞) */
export const timeOf = (source: string) => parseSource(source).at?.getTime() ?? 0;
