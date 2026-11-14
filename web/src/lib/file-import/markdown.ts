// .md / .txt 읽기
import { fileHeading, finalizeSections, type RawSection } from "./sections";
import { normalizeText } from "./text";
import type { ParseResult } from "./types";

const HEADING = /^ {0,3}(#{1,3})\s+(\S.*?)\s*#*\s*$/; // # ~ ### (닫는 # 은 떼어 낸다)
const FENCE = /^ {0,3}(```|~~~)/;
const PLAIN_SECTION_CHARS = 1800; // 제목 줄을 더해도 2000 안에 들어오게

/**
 * 마크다운을 제목(#~###) 기준으로 나눈다. 제목 앞의 글은 "[파일명]" 구획, 코드 블록 안의 # 줄은 제목이 아니다.
 * 구획의 제목 줄은 마크다운 제목 그대로("## 설계 원칙")
 */
export function parseMarkdown(source: string, fileName: string): ParseResult {
  const lines = normalizeText(source).split("\n");
  const raw: RawSection[] = [{ heading: fileHeading(fileName), text: "" }];
  let body: string[] = [];
  let fence: string | null = null;
  const close = () => {
    raw[raw.length - 1]!.text = body.join("\n");
    body = [];
  };
  for (const line of lines) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fenceMark) fence = fence === null ? fenceMark : fence === fenceMark ? null : fence;
    const heading = fence === null ? HEADING.exec(line) : null;
    if (heading) {
      close();
      raw.push({ heading: `${heading[1]} ${heading[2]}`, text: "" });
    } else {
      body.push(line);
    }
  }
  close();
  return { sections: finalizeSections(raw), warnings: [] };
}

/** 일반 글(.txt)을 빈 줄 단위 문단으로 묶어 1800자쯤의 구획으로 나눈다 */
export function parsePlainText(source: string, fileName: string): ParseResult {
  const paragraphs = normalizeText(source)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const groups: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + 2 + paragraph.length > PLAIN_SECTION_CHARS) {
      groups.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) groups.push(current);
  // 한 문단이 구획보다 길면 조각 나누기(chunkSection)가 같은 구획 안에서 이어서 쪼갠다
  const raw = groups.map((text, i) => ({ heading: fileHeading(fileName, `${i + 1}번째 부분`), text }));
  return { sections: finalizeSections(groups.length === 1 ? [{ heading: fileHeading(fileName), text: groups[0]! }] : raw), warnings: [] };
}
