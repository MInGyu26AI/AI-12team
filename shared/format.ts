// 출처 문자열과 시각 표시. 출력 형식의 source 는 "ChatGPT, 2026-11-06 21:10" 이다.

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
/** 로컬 시각 기준 "2026-11-06" */
export const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const fmtMD = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
export const fmtHM = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export const fmtMDHM = (d: Date) => `${fmtMD(d)} ${fmtHM(d)}`;

/** parseSource 의 반대: ("ChatGPT", 시각) → "ChatGPT, 2026-11-06 21:10" */
export const formatSource = (label: string, at = new Date()) => `${label}, ${ymd(at)} ${fmtHM(at)}`;

/** "2026-11-07" → "11/7" */
export const fmtDue = (due: string) => {
  const [, m, d] = due.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : due;
};

/** 시각 순서 비교용 (시각이 없으면 맨 앞) */
export const timeOf = (source: string) => parseSource(source).at?.getTime() ?? 0;
