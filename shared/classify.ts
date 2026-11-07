// 목업 분류기 (웹·확장 공용). docs/classification.md "신호 표현" 키워드로 대충 분류한다.
// 나중에 김동균 님 로컬 수집기 결과로 바꿀 때는 mockClassify 한 함수만 교체하면 된다.
import type { Card, RelatedCard, Speaker, Subtopic, Tag } from "./types";

export interface Utterance {
  speaker: Speaker;
  text: string;
  source: string; // 예: "ChatGPT, 2026-11-06 21:10"
}

// 분류 프롬프트에 함께 넣는 정보 (docs/classification.md 4장)
export interface ClassifyContext {
  userName: string; // "내가" = 이 사람
  knownNames?: string[]; // 담당자 인식용 이름 목록
  existingTopicKeys?: string[]; // 기존 세부 주제 (있으면 그 이름 먼저)
  enabledSubtopics?: Subtopic[]; // 켜 둔 소주제. 꺼진 소주제는 "기타"로
}

// ── 민감정보 가림 (어느 단계든 먼저) ──
const SENSITIVE: [RegExp, string][] = [
  [/01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g, "[연락처]"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[이메일]"],
  [/\d{6}-?[1-4]\d{6}/g, "[주민번호]"],
  [/\d{3,6}-\d{2,6}-\d{4,8}/g, "[계좌]"], // 날짜(2026-11-06)는 안 걸리게
]; // ai/syncup_ai/mask.py 와 같은 규칙·순서
export function mask(text: string) {
  let masked = false;
  let out = text;
  for (const [re, label] of SENSITIVE) {
    out = out.replace(re, () => ((masked = true), label));
  }
  return { text: out, masked };
}

// ── 문장 나누기: 마침표·물음표·줄바꿈, 그리고 "~하고," / "~해서 ~로 가자" 같은 복합문 ──
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .flatMap((s) => s.split(/(?<=(?:하고|이고|로 하고),)\s*/))
    .flatMap((s) => s.split(/(?<=싸서|해서|보니)\s+(?=\S+(?:으)?로 (?:하자|가자))/))
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// ── 1단계 관련성 ──
// 팀 일정에 영향을 줘도 본인 사정(병원·알바·약속)은 개인 (민규 님 정답표)
const PERSONAL = /점심|저녁|아침|약속|기분|시험|병원|김밥|편하더라|좋더라|피곤|졸려|데이트|수업 끝나고|알바|본가|잠을 못/;

// ── 3단계 표시 (위에서부터 먼저 맞는 것) ──
const SUGGESTION = /하면 어때|할까\?|어때\?|어떨까|해 볼까|는 어때|게 어때/;
// 요청 속에 숨은 결정: "FastAPI 기준으로 코드 짜 줘" → 서버 = FastAPI
const HIDDEN_DECISION = /\S+\s?기준으로\s.*(?:짜|써|만들어|정리해)\s?줘/;
// 주의: JS 의 \b 는 한글 뒤에서 동작하지 않으므로 쓰지 않는다
const RESEARCH = /(?:래|대)(?:[.!]|$)|에 따르면|찾아보니|비교해 보니|랬어|하더라고|추천했어|기억해/;
const TODO = /할게|해야 해|해야 돼|까지|맡아|해 ?줘|보내 ?줘|만들어야/;
const DECISION = /(?:으)?로 (?:하자|가자|정했어|정하자|바꾸자|하고)|정했어|확정|바꾸자|하지 말자|넣자|빼자|하자(?:[.!]|$|\s)/;
const CHANGE = /바꾸|변경|대신|취소|빼자|도\s?\S*에 넣자/;

// ── 2단계 소주제 (위에서부터 먼저 맞는 것) ──
const SUBTOPIC_RULES: [Subtopic, RegExp][] = [
  ["발표·제출", /발표|PPT|슬라이드|제출|업로드/i],
  ["과제 조건·피드백", /교수님|공지|평가 기준|심사 기준|분량|형식|피드백|\d+쪽/],
  ["주제·목표", /주제|목표|방향|범위|타깃|서비스명|이름/],
  ["작업·결과물", /본문|분석|코드|디자인|실험|초안|구성|화면|MVP|확장|기능|모델|API로|GPT로/],
  ["자료 조사", /찾아보니|따르면|통계|사례|비교|가격/],
  ["역할·일정", /맡아|까지|회의|모이자|담당|할게/],
];

// ── 세부 주제(topic_key): 기존 이름 먼저 ──
const TOPIC_RULES: [string, RegExp][] = [
  ["서비스명", /서비스명|이름/],
  ["타깃", /타깃/],
  ["브라우저 확장 심사", /웹스토어/],
  ["MVP 범위", /MVP|브라우저 확장/],
  ["분석 방법", /분석/],
  ["화면 구성", /화면/],
  ["분류 기준", /기준표|분류 기준/],
  ["API 서버", /API 서버|배포/],
  ["API 가격", /가격/],
  ["AI 모델", /GPT로|Claude로|모델/],
  ["발표 자료", /발표 자료|PPT|슬라이드/],
  ["발표 담당", /발표/],
  ["분량", /분량|\d+쪽/],
  ["경쟁 서비스", /ChatGPT|카나나|경쟁/],
];

function pickTag(s: string): Tag | null {
  if (SUGGESTION.test(s)) return "none";
  if (/[가이]\s?(?:맡아|하자)/.test(s)) return "todo"; // "유나가 하자" = 담당 지정
  if (RESEARCH.test(s)) return "research";
  if (HIDDEN_DECISION.test(s)) return "decision";
  if (TODO.test(s)) return "todo";
  if (DECISION.test(s)) return "decision";
  return null;
}

// "하린" → "정하린" (팀원 이름 목록에서 이름 부분이 맞는 사람)
function resolveName(given: string, ctx: ClassifyContext): string {
  return (ctx.knownNames ?? []).find((full) => full === given || (full.length >= 3 && full.slice(1) === given)) ?? given;
}

/** speakerName = 단톡방 붙여넣기 줄의 화자 ("[유나] …"). 없으면 대화를 보낸 사용자 */
function pickOwner(s: string, tag: Tag, ctx: ClassifyContext, speakerName?: string): string | null {
  const speaker = speakerName ? resolveName(speakerName, ctx) : ctx.userName;
  if (/내가|제가/.test(s)) return speaker;
  for (const full of ctx.knownNames ?? []) {
    const given = full.length >= 3 ? full.slice(1) : full; // "김동균" → "동균"
    if (s.includes(given) && full !== speaker) return full; // "지민이가 만들어 주기로" → 박지민
  }
  return tag === "decision" ? speaker : null; // 결정자 = 말한 사람
}

// 규칙에 없는 세부 주제: 군말("찾아보니", "근데" …)을 건너뛴 첫 낱말에서 조사를 뗀 것
const FILLER = /^(찾아보니|참고로|근데|그럼|그리고|아|음|난|나|내가|이거|그거|우리|오늘|내일|일단|혹시)$/;
function fallbackTopic(body: string): string {
  const word = body.split(/\s+/).find((w) => w && !FILLER.test(w)) ?? body;
  return word.replace(/(은|는|이|가|을|를|도|랑|이랑)$/, "") || "기타";
}

const CHAT_LINE = /^\[([^\]\s]{1,10})\]\s*(.+)$/; // 단톡방 한 줄: [하린] 서버는 …
export const MAX_CARDS_PER_AI_MESSAGE = 2; // config.MAX_CARDS_PER_AI_MESSAGE

const WEEKDAYS = "일월화수목금토";
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "내일", "모레", "금요일", "11월 8일", "11/8" → YYYY-MM-DD (기준: 발화 시각)
function pickDue(s: string, base: Date): string | null {
  const d = new Date(base);
  if (/모레/.test(s)) return d.setDate(d.getDate() + 2), ymd(d);
  if (/내일/.test(s)) return d.setDate(d.getDate() + 1), ymd(d);
  if (/오늘/.test(s)) return ymd(d);
  const md = s.match(/(\d{1,2})\s?(?:월|\/)\s?(\d{1,2})/);
  if (md) return ymd(new Date(d.getFullYear(), Number(md[1]) - 1, Number(md[2])));
  const wd = s.match(/([일월화수목금토])요일/);
  if (wd && /까지/.test(s)) {
    const diff = (WEEKDAYS.indexOf(wd[1]!) - d.getDay() + 7) % 7 || 7;
    return d.setDate(d.getDate() + diff), ymd(d);
  }
  return null;
}

const baseDate = (source: string) => {
  const m = source.match(/(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/);
  return m ? new Date(`${m[1]}T${m[2] ?? "12:00"}:00`) : new Date();
};

let seq = 0;
const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

/** 발화 목록 → 후보 카드 (개인 카드 포함. 개인은 sentence 없이 relevance 만) */
export function mockClassify(utterances: Utterance[], ctx: ClassifyContext): Card[] {
  const known = new Set(ctx.existingTopicKeys ?? []);
  const enabled = ctx.enabledSubtopics ? new Set<Subtopic>(ctx.enabledSubtopics) : null;
  const cards: Card[] = [];

  for (const u of utterances) {
    let aiCards = 0;
    for (const raw of splitSentences(u.text)) {
      const { text: masked0, masked } = mask(raw);
      const chat = u.speaker === "user" ? masked0.match(CHAT_LINE) : null;
      const sentence = masked0;
      const body = chat ? chat[2]! : masked0;
      let tag = pickTag(body);
      // AI 답변은 결정·할 일이 될 수 없음 → 제안 (ai/syncup_ai/classify.py 와 같음)
      if (u.speaker === "ai" && (tag === "decision" || tag === "todo")) tag = "none";
      if (u.speaker === "ai" && tag !== null && !PERSONAL.test(body) && ++aiCards > MAX_CARDS_PER_AI_MESSAGE) continue;
      const common = { id: newId(), source: u.source, masked, status: "candidate" as const };

      // AI 답변의 인사·추천 같은 군말은 카드도 개인도 아님 (해당 없음 → 만들지 않음)
      if (u.speaker === "ai" && tag === null && !PERSONAL.test(body)) continue;
      if (PERSONAL.test(body) || tag === null) {
        // 개인: 문장은 저장하지 않는다
        cards.push({ ...common, relevance: "personal", confidence: PERSONAL.test(body) ? 0.85 : 0.5 });
        continue;
      }

      let subtopic: Subtopic | null =
        tag === "none"
          ? null
          : (SUBTOPIC_RULES.find(([, re]) => re.test(body))?.[0] ??
            (tag === "todo" ? "역할·일정" : tag === "research" ? "자료 조사" : "기타"));
      if (subtopic && enabled && !enabled.has(subtopic)) subtopic = "기타"; // 꺼 둔 소주제
      const topic_key =
        tag === "none"
          ? null
          : (TOPIC_RULES.find(([, re]) => re.test(body))?.[0] ?? fallbackTopic(body));
      const owner = tag === "decision" || tag === "todo" ? pickOwner(body, tag, ctx, chat?.[1]) : null;
      const due = tag === "todo" ? pickDue(body, baseDate(u.source)) : null;

      let confidence = 0.8;
      if (tag === "todo" && !owner) confidence = 0.5; // 담당 미정 → 확인 필요
      if (subtopic === "기타") confidence -= 0.15;

      const card: RelatedCard = {
        ...common,
        relevance: "related",
        sentence,
        subtopic,
        tag,
        topic_key,
        is_new_topic: topic_key ? !known.has(topic_key) : false,
        content: body.replace(/[.?!]+$/, ""),
        reason: null,
        owner,
        due,
        is_change: tag === "decision" && CHANGE.test(body),
        confidence: Math.round(confidence * 100) / 100,
      };
      if (topic_key) known.add(topic_key);
      cards.push(card);
    }
  }
  return cards;
}

// ── 붙여넣은 대화 → 발화. "나:", "You said:", "ChatGPT:" 같은 화자 표시를 읽는다 ──
const USER_PREFIX = /^(?:나|me|user|you said|you|사용자)\s*:?\s*$|^(?:나|me|user|you|사용자)\s*:\s*/i;
const AI_PREFIX = /^(?:chatgpt|gpt|claude|gemini|ai|assistant)(?: said)?\s*:?\s*$|^(?:chatgpt|gpt|claude|gemini|ai|assistant)\s*:\s*/i;

export function parsePasted(text: string, source: string): Utterance[] {
  const out: Utterance[] = [];
  let speaker: Speaker = "user";
  for (const line of text.split(/\r?\n/)) {
    let body = line;
    if (USER_PREFIX.test(line)) {
      speaker = "user";
      body = line.replace(USER_PREFIX, "");
    } else if (AI_PREFIX.test(line)) {
      speaker = "ai";
      body = line.replace(AI_PREFIX, "");
    }
    if (!body.trim()) continue;
    const last = out.at(-1);
    if (last && last.speaker === speaker) last.text += "\n" + body;
    else out.push({ speaker, text: body, source });
  }
  return out;
}

export const nowSource = (label: string, d = new Date()) =>
  `${label}, ${ymd(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
