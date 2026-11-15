// 본문 정리와 조각 나누기 (순수 함수)
import type { ParsedSection } from "./types";

/** 조각 하나의 글자 수 상한 (제목 줄 포함) */
export const MAX_CHUNK_CHARS = 2000;
/** 제목이 이보다 길면 잘라 쓴다 (본문 자리를 남기려고) */
const MAX_HEADING_CHARS = 120;
const MAX_REPEAT_CHARS = 300;

/** 비교·해시용 정리: NFC · 줄바꿈 통일 · 제어 문자 제거 · 줄 끝 공백 제거 · 빈 줄 3개 이상을 2개로 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 공백을 뺀 글자 수 (글자가 거의 없는 쪽을 가려낼 때) */
export const nonSpaceLength = (s: string) => s.replace(/\s/g, "").length;

/** 한 줄 제목으로 만든다. 너무 길면 자른다 */
export function cleanHeading(heading: string): string {
  const line = heading.replace(/\s+/g, " ").trim();
  return line.length > MAX_HEADING_CHARS ? `${line.slice(0, MAX_HEADING_CHARS - 1)}…` : line;
}

// 서로게이트 쌍 가운데서 자르지 않는다
function safeCut(s: string, at: number): number {
  const code = at > 0 ? s.charCodeAt(at - 1) : 0;
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

// window(길이 max) 안에서 자를 자리: 줄바꿈 → 문장 끝 → 공백 → 그냥 max. 너무 앞(40% 미만)이면 다음 후보로 넘어간다
function bestCut(window: string, max: number): number {
  const min = Math.floor(max * 0.4);
  const newline = window.lastIndexOf("\n");
  if (newline + 1 >= min) return newline + 1;
  let sentence = -1;
  for (const m of window.matchAll(/[.!?。…][)"'」』]?(?:\s|$)/g)) sentence = m.index + m[0].length;
  if (sentence >= min) return sentence;
  const space = window.lastIndexOf(" ");
  if (space + 1 >= min) return space + 1;
  return safeCut(window, max);
}

// 한 문단이 max 보다 길 때 나눈다. 항상 앞으로 나아간다
function splitLong(piece: string, max: number): string[] {
  const out: string[] = [];
  let rest = piece;
  while (rest.length > max) {
    const cut = Math.max(1, bestCut(rest.slice(0, max), max));
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** 본문을 max 글자 이하 조각으로 나눈다. 문단(빈 줄) 경계를 먼저 쓰고, 문단이 길면 줄·문장 순으로 쪼갠다 */
export function chunkText(text: string, max: number): string[] {
  const body = normalizeText(text);
  if (!body) return [];
  if (body.length <= max) return [body];
  const pieces = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => splitLong(p, max));
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + 2 + piece.length <= max) current += `\n\n${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * 구획 하나를 제목으로 시작하는 조각들로 만든다. 조각마다 제목 줄이 맨 앞에 오고 전체가 max 글자 이하다.
 * 조각이 여럿이고 repeat(표 머리글 행)가 있으면 둘째 조각부터 제목 밑에 그 줄을 다시 붙인다
 */
export function chunkSection(section: Pick<ParsedSection, "heading" | "text" | "repeat">, max = MAX_CHUNK_CHARS): string[] {
  const body = normalizeText(section.text);
  if (!body) return [];
  const head = `${cleanHeading(section.heading)}\n`;
  if (head.length + body.length <= max) return [`${head}${body}`];
  const repeat = section.repeat ? normalizeText(section.repeat).slice(0, MAX_REPEAT_CHARS) : "";
  // 본문 자리가 400자도 안 남으면 반복 줄은 붙이지 않는다
  const repeatLine = repeat && max - head.length - repeat.length - 1 >= 400 ? `${repeat}\n` : "";
  const chunks = chunkText(body, max - head.length - repeatLine.length);
  return chunks.map((chunk, i) => `${head}${i ? repeatLine : ""}${chunk}`);
}
