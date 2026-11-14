// 카카오톡 대화(복사한 글, 내보낸 .txt)를 붙여넣기에서 알아보고 메시지로 나눈다. 브라우저 안에서만 돈다.
// 형식은 카카오 고객센터의 내보내기 안내와 오픈소스 파서들의 정규식에 맞췄다: Windows PC, Android 한국어·영어.
// iOS 형식과 카톡 앱에서 여러 메시지를 복사한 형식은 아직 실제 글로 대조하지 못했다.
// 사진·동영상·파일 같은 첨부는 가져오지 않고 개수만 센다(추후 확장).
import type { CollectedMessage } from "./collector";
import { formatSource } from "./format";
import type { Utterance } from "./utterance";

export interface KakaoMessage {
  speaker: string; // 카톡에 보이는 이름
  minute: string; // "2026-11-09T15:12" (날짜를 모르면 today 의 날짜)
  dated: boolean; // 날짜 줄이나 메시지 머리에서 날짜를 읽었는지
  text: string;
}

export interface KakaoParse {
  roomName: string | null; // 내보내기 머리줄 "… 님과 카카오톡 대화"
  messages: KakaoMessage[];
  speakers: { name: string; count: number }[]; // 메시지가 많은 순
  skipped: { attachments: number; system: number; unreadable: number };
}

// 화자를 어떻게 다룰지. member 의 name 은 팀 보드에 쓰일 이름 (기본은 카톡 이름)
export type KakaoRole = { kind: "me" } | { kind: "member"; name: string } | { kind: "skip" };
// mine: 내 메시지만. team: 나 + member 로 고른 화자, skip 은 어느 쪽이든 보내지 않는다
export type KakaoMode = "mine" | "team";

export interface KakaoRoom {
  key: string; // 이 브라우저에서 만든 임의 값. 발화 id 와 대화 id 에 들어가 다시 붙여 넣어도 같은 메시지를 알아본다
  name: string;
  team: string; // 팀 이름. 다른 팀의 방은 목록에 안 보인다
  roles: Record<string, KakaoRole>;
  teamConfirmed: boolean; // '팀 전체'를 켤 때 받은 확인
}

// 수집기가 받는 출처 중 '직접 입력'. 카톡 전용 출처(kakaotalk-export)는 수집기 INTAKE_SITES 를 고친 뒤에 쓴다
const SITE: CollectedMessage["site"] = "manual";
// 수집기는 사용자 발화 앞 2000자만 검사·분류한다 (ai/syncup_ai/config.py MAX_USER_CHARS)
export const MAX_PIECE = 2000;
// 대화 덩어리(turnId 하나 = 분류 묶음의 1턴): 앞 메시지와 10분 이내, 메시지 20개·4000자까지
export const TURN_GAP_MINUTES = 10;
export const TURN_MAX_MESSAGES = 20;
export const TURN_MAX_CHARS = 4000;

const AMPM = "(오전|오후)";
const PC_DATE = /^-{3,}\s*(\d{4})년 (\d{1,2})월 (\d{1,2})일 \S+요일\s*-{3,}$/;
const PC_DATE_EN = /^-{3,}\s*\w+day, (\w+) (\d{1,2}), (\d{4})\s*-{3,}$/;
const PC_MESSAGE = new RegExp(`^\\[(.+?)\\] \\[${AMPM} (\\d{1,2}):(\\d{2})\\] ?(.*)$`);
const PC_MESSAGE_EN = /^\[(.+?)\] \[(\d{1,2}):(\d{2}) (AM|PM)\] ?(.*)$/;
const MOBILE_HEAD = new RegExp(`^(\\d{4})년 (\\d{1,2})월 (\\d{1,2})일 ${AMPM} (\\d{1,2}):(\\d{2}), (.*)$`);
const IOS_HEAD = new RegExp(`^(\\d{4})\\. (\\d{1,2})\\. (\\d{1,2})\\.? ${AMPM} (\\d{1,2}):(\\d{2}),? (.*)$`);
const MOBILE_HEAD_EN = /^(\w+) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}) (AM|PM),? (.*)$/;
const MOBILE_DATE = /^(\d{4})년 (\d{1,2})월 (\d{1,2})일 \S+요일$/;
const ROOM_HEAD = /^(.+?) 님과 카카오톡 대화$/;
const SAVED_AT = /^(저장한 날짜|Date Saved)\s*:/;
const ATTACHMENT = /^(사진|동영상|이모티콘|음성메시지|음성 메시지|\(이모티콘\)|사진 \d+장|Photo|Photos|Video|Emoticon|Voice message|파일: .+|File: .+)$/;
const SYSTEM = [
  /님이 (들어왔습니다|나갔습니다)\.?$/,
  /님을 (초대했습니다|내보냈습니다)\.?$/,
  /^(삭제된 메시지입니다|메시지가 삭제되었습니다|This message was deleted)\.?$/,
  /^(보이스톡|페이스톡)( 해요| 취소| \d{1,2}:\d{2}(:\d{2})?)$/,
  /(joined|left) this chatroom\.?$/,
];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const p2 = (n: number) => String(n).padStart(2, "0");
const hour24 = (h: number, pm: boolean) => (h % 12) + (pm ? 12 : 0);
const monthOf = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3))) + 1;
const isSystem = (body: string) => SYSTEM.some((re) => re.test(body));

type Day = { y: number; m: number; d: number };
type Head = { day: Day | null; h: number; mi: number; speaker: string | null; body: string };

/** 메시지 머리 한 줄 → 날짜·시각·화자·본문. 시스템 줄(모바일 '시각, 내용')은 speaker 가 null */
function readHead(line: string): Head | null {
  let x = PC_MESSAGE.exec(line);
  if (x) return { day: null, h: hour24(+x[3], x[2] === "오후"), mi: +x[4], speaker: x[1], body: x[5] };
  x = PC_MESSAGE_EN.exec(line);
  if (x) return { day: null, h: hour24(+x[2], x[4] === "PM"), mi: +x[3], speaker: x[1], body: x[5] };
  const mobile = (day: Day, h: number, mi: number, rest: string): Head => {
    const sep = rest.indexOf(" : ");
    return sep > 0
      ? { day, h, mi, speaker: rest.slice(0, sep), body: rest.slice(sep + 3) }
      : { day, h, mi, speaker: null, body: rest };
  };
  x = MOBILE_HEAD.exec(line) ?? IOS_HEAD.exec(line);
  if (x) return mobile({ y: +x[1], m: +x[2], d: +x[3] }, hour24(+x[5], x[4] === "오후"), +x[6], x[7]);
  x = MOBILE_HEAD_EN.exec(line);
  if (x && monthOf(x[1]) > 0) return mobile({ y: +x[3], m: monthOf(x[1]), d: +x[2] }, hour24(+x[4], x[6] === "PM"), +x[5], x[7]);
  return null;
}

function readDate(line: string): Day | null {
  let x = PC_DATE.exec(line) ?? MOBILE_DATE.exec(line);
  if (x) return { y: +x[1], m: +x[2], d: +x[3] };
  x = PC_DATE_EN.exec(line);
  if (x && monthOf(x[1]) > 0) return { y: +x[3], m: monthOf(x[1]), d: +x[2] };
  return null;
}

/**
 * 붙여 넣은 글이 카톡 대화면 메시지로 나누고, 아니면 null (그때는 parsePasted 로).
 * 메시지 머리가 있는 줄이 비어 있지 않은 줄의 30% 이상이어야 카톡으로 본다.
 * 머리 없는 줄은 앞 메시지에 이어 붙이고, 첨부·시스템 줄은 버리고 센다.
 */
export function parseKakao(text: string, today?: Date): KakaoParse | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^﻿/, "").trimEnd());
  const nonEmpty = lines.filter((l) => l.trim());
  const heads = nonEmpty.filter((l) => readHead(l)?.speaker);
  if (!heads.length || heads.length < nonEmpty.length * 0.3) return null;

  // 지금 시각은 카톡 글로 알아본 뒤에만 읽는다 (빈 칸으로 미리 그릴 때 Next.js 가 시각 값을 막는다)
  const now = today ?? new Date();
  const fallback: Day = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const out: KakaoParse = { roomName: null, messages: [], speakers: [], skipped: { attachments: 0, system: 0, unreadable: 0 } };
  let day: Day | null = null;
  let last: KakaoMessage | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const room = ROOM_HEAD.exec(trimmed);
    if (room && !out.messages.length) {
      out.roomName = room[1];
      continue;
    }
    if (SAVED_AT.test(trimmed)) continue;
    const date = readDate(trimmed);
    if (date) {
      day = date;
      last = null;
      continue;
    }
    const head = readHead(trimmed);
    if (head) {
      last = null;
      if (head.day) day = head.day;
      const body = head.body.trim();
      if (!head.speaker || isSystem(body)) {
        out.skipped.system++;
        continue;
      }
      if (ATTACHMENT.test(body)) {
        out.skipped.attachments++;
        continue;
      }
      const d = day ?? fallback;
      last = { speaker: head.speaker, minute: `${d.y}-${p2(d.m)}-${p2(d.d)}T${p2(head.h)}:${p2(head.mi)}`, dated: !!day, text: body };
      out.messages.push(last);
      continue;
    }
    if (isSystem(trimmed)) out.skipped.system++;
    else if (last) last.text = last.text ? `${last.text}\n${trimmed}` : trimmed;
    else out.skipped.unreadable++;
  }
  out.messages = out.messages.filter((m) => m.text.trim());
  const counts = new Map<string, number>();
  for (const m of out.messages) counts.set(m.speaker, (counts.get(m.speaker) ?? 0) + 1);
  out.speakers = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return out;
}

/** 짧고 안정적인 내용 지문 (cyrb53, 암호용 아님). 같은 화자·같은 글이면 같은 값 */
function fingerprint(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** MAX_PIECE 이하 조각으로. 줄 바꿈에서 먼저 자르고, 한 줄이 너무 길면 글자 수로 */
function pieces(text: string): string[] {
  if (text.length <= MAX_PIECE) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (let rest = line; rest.length; rest = rest.slice(MAX_PIECE)) {
      const part = rest.slice(0, MAX_PIECE);
      if (cur && cur.length + 1 + part.length > MAX_PIECE) {
        out.push(cur);
        cur = part;
      } else cur = cur ? `${cur}\n${part}` : part;
      if (rest.length <= MAX_PIECE) break;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const minutesOf = (minute: string) => Date.parse(`${minute}:00+09:00`) / 60000;

export interface KakaoSelection {
  utterances: Utterance[];
  mine: number; // 보낼 내 메시지 수
  members: number; // 보낼 팀원 메시지 수
  first: string | null; // 보낼 메시지의 처음·마지막 시각 (minute)
  last: string | null;
}

/**
 * 고른 방·화자 역할·모드로 수집기에 보낼 발화를 만든다.
 * - 내 메시지는 두 모드에서 id·본문이 같다. 그래서 '내 글만'으로 올린 방을 '팀 전체'로 다시 올려도 내 메시지는 이미 보낸 것으로 건너뛴다.
 * - 팀원 메시지는 본문 앞에 "[이름] "을 붙인다. 분류 기준(ai/prompts/classify_system.md '붙여넣은 단톡방')대로 그 사람이 결정자·담당자가 된다.
 * - id: kakao:<방 키>:<분>:<지문>:<같은 분·같은 지문 안 순번>:<조각>. 날짜를 모르면 분 자리에 시각만(t1512).
 */
export function kakaoSelection(parsed: KakaoParse, room: KakaoRoom, mode: KakaoMode): KakaoSelection {
  const seen = new Map<string, number>();
  const utterances: Utterance[] = [];
  let mine = 0;
  let members = 0;
  let turn: { id: string; count: number; chars: number; at: number } | null = null;
  let first: string | null = null;
  let last: string | null = null;
  for (const m of parsed.messages) {
    const role = room.roles[m.speaker] ?? { kind: "skip" };
    if (role.kind === "skip" || (role.kind === "member" && mode === "mine")) continue;
    const minuteKey = m.dated ? m.minute.replace(/[-T:]/g, "") : `t${m.minute.slice(11).replace(":", "")}`;
    const mark = fingerprint(`${m.speaker}\n${m.text.replace(/\s+/g, " ").trim()}`);
    const key = `${minuteKey}:${mark}`;
    const seq = seen.get(key) ?? 0;
    seen.set(key, seq + 1);
    const base = `kakao:${room.key}:${key}:${seq}`;
    const at = minutesOf(m.minute);
    if (!turn || at - turn.at > TURN_GAP_MINUTES || turn.count >= TURN_MAX_MESSAGES || turn.chars + m.text.length > TURN_MAX_CHARS) {
      turn = { id: `${base}:turn`, count: 0, chars: 0, at };
    }
    turn.count++;
    turn.chars += m.text.length;
    turn.at = at;
    const turnId = turn.id;
    const source = formatSource("카카오톡", new Date(at * 60000));
    // 팀원 메시지는 줄마다 이름을 붙인다: 분류 기준이 '줄마다 그 줄의 화자'로 판단하기 때문 (여러 줄 메시지의 둘째 줄도 그 사람 말)
    const label = role.kind === "member" ? `[${role.name.trim() || m.speaker}] ` : "";
    const named = label ? m.text.split("\n").map((line) => label + line).join("\n") : m.text;
    pieces(named).forEach((piece, i) =>
      utterances.push({
        id: `${base}:${i}`,
        conversationId: `kakao:${room.key}`,
        collectedAt: `${m.minute}:00+09:00`,
        roleGuessed: false,
        speaker: "user",
        text: piece,
        source,
        site: SITE,
        turnId,
      }),
    );
    if (role.kind === "me") mine++;
    else members++;
    first ??= m.minute;
    last = m.minute;
  }
  return { utterances, mine, members, first, last };
}

/** 처음 보는 화자의 기본 역할: 내 이름이면 나, 아는 팀원 이름이면 팀원, 그 밖은 보내지 않음 */
export function defaultRole(speaker: string, me: string, knownNames: string[]): KakaoRole {
  if (me && speaker === me) return { kind: "me" };
  if (knownNames.includes(speaker)) return { kind: "member", name: speaker };
  return { kind: "skip" };
}
