// 파서들이 함께 쓰는 구획 도우미
import { normalizeText } from "./text";
import type { ParsedSection } from "./types";

/** "[파일명]" 또는 "[파일명 · 3쪽]" 모양의 제목 줄 */
export const fileHeading = (fileName: string, part?: string | number) => `[${fileName.trim() || "파일"}${part === undefined ? "" : ` · ${part}`}]`;

export interface RawSection {
  heading: string;
  text: string;
  repeat?: string;
}

/** 본문이 빈 구획을 빼되, 남은 구획의 번호(index)는 원래 위치로 둔다. 빠진 구획 때문에 turnId 가 밀리지 않게 */
export function finalizeSections(raw: RawSection[]): ParsedSection[] {
  const out: ParsedSection[] = [];
  raw.forEach((section, index) => {
    const text = normalizeText(section.text);
    if (text) out.push({ heading: section.heading, text, ...(section.repeat ? { repeat: section.repeat } : {}), index });
  });
  return out;
}
