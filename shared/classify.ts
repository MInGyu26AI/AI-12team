// 분류 전 가림(mask)과 웹 목업 모드의 규칙 분류기(mockClassify).
// 실제 모드의 분류는 로컬 수집기(ai/syncup_ai)가 한다. mockClassify 는 docs/classification.md "신호 표현" 키워드로 대충 분류한다.
// check_mask_cases.cjs 가 이 파일을 그대로 읽어 mask() 를 검사하므로 런타임 import 를 두지 않는다 (타입 import 만).
import type { Card, RelatedCard, Speaker, Subtopic, Tag } from "./types";
import type { Utterance } from "./utterance";

// 분류 프롬프트에 함께 넣는 정보 (docs/classification.md 4장)
export interface ClassifyContext {
  userName: string; // "내가" = 이 사람
  knownNames?: string[]; // 담당자 인식용 이름 목록
  existingTopicKeys?: string[]; // 기존 세부 주제 (있으면 그 이름 먼저)
  enabledSubtopics?: Subtopic[]; // 켜 둔 소주제. 꺼진 소주제는 "기타"로
}

// ── 민감정보·인증정보 가림 (어느 단계든 먼저) ──
// ai/syncup_ai/mask.py 와 같은 규칙·같은 순서. 둘 다 shared/mask-cases.json 으로 검사한다.
// 순서: 인증정보(키·토큰) → 개인정보. 인증정보를 먼저 가려야 계좌 규칙이 토큰 일부만 잘라 뒷부분이 남지 않는다.
// 서버 토큰(43자, 접두사 없음)은 Bearer·token=·"access_token": 같은 인증 문맥이 있을 때만 가림 (동균 님과 11/8 합의).
const TAIL = String.raw`(?:(?:\.{2,3}|…)[A-Za-z0-9_-]+)?`; // "sk-proj-abcd...wxyz" 의 뒷부분까지
const VALUE_END = String.raw`\s"'&,;)}\]\\`; // 값 끝: 공백·따옴표·구분자·역슬래시(JSON 이스케이프)
type Replacer = string | ((match: string, ...groups: string[]) => string);

const SENSITIVE: [RegExp, Replacer][] = [
  [/(\b(?:\w*_)?(?:token|secret|api[_-]?key|passw(?:or)?d)["']?\s*[:=]\s*)(["'])(?!\[)([^"'\r\n]+)\2/gi,
    (_, keep, quote) => keep + quote + (/passw/i.test(keep) ? "[비밀번호]" : /api[_-]?key/i.test(keep) ? "[API키]" : "[액세스토큰]") + quote],
  [/((?:주소|건강정보|개인사정)\s*[:=]\s*)(["'])(?!\[)([^"'\r\n]+)\2/g,
    (_, keep, quote) => keep + quote + "[" + keep.match(/주소|건강정보|개인사정/)![0] + "]" + quote],
  [/((?:주소|건강정보|개인사정)\s*[:=]\s*)(?![\s\["'])[^\n\r.;,"']+/g,
    (_, keep) => keep + "[" + keep.match(/주소|건강정보|개인사정/)![0] + "]"],
  // 인증정보
  [new RegExp(String.raw`(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}|(?=\.{3}|…))` + TAIL, "g"), "[API키]"],
  [new RegExp(String.raw`(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})` + TAIL, "g"), "[액세스토큰]"],
  [/(authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?)(?!\[)[A-Za-z0-9._~+/=-]{8,}/gi, (_, keep) => keep + "[액세스토큰]"],
  [/(\bbearer\s+)(?!\[)[A-Za-z0-9._~+/=-]{8,}/gi, (_, keep) => keep + "[액세스토큰]"],
  [
    new RegExp(
      String.raw`(\b((?:\w*_)?(?:token|secret|api[_-]?key|passw(?:or)?d))\\?["']?\s*[:=]\s*\\?["']?)` + // \" (JSON 안 JSON)도
        String.raw`(?!\[)(?!(?:null|none|true|false|undefined)\b)(?!\d{1,9}(?![^${VALUE_END}]))` +
        String.raw`[^${VALUE_END}]{4,}`,
      "gi",
    ),
    (_, keep, key) =>
      keep + (/api[_-]?key/i.test(key) ? "[API키]" : /passw/i.test(key) ? "[비밀번호]" : "[액세스토큰]"),
  ],
  // 개인정보
  // 국제 표기(+82)와 지역번호 유선전화(02·031·070 …)도 연락처다. 계좌 규칙보다 먼저 둔다.
  [/(?<!\d)\+82[-.\s]?0?(?:1[016789]|2|[3-6][1-5]|70)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g, "[연락처]"],
  [/(?<![\d-])0(?:2|[3-6][1-5]|70)[-.\s)]\s?\d{3,4}[-.\s]\d{4}(?!\d)/g, "[연락처]"],
  [/01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g, "[연락처]"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[이메일]"],
  [/\d{6}-?[1-4]\d{6}/g, "[주민번호]"],
  [/\d{3,6}-\d{2,6}-\d{4,8}/g, "[계좌]"], // 날짜(2026-11-06)는 안 걸리게
];

export function mask(text: string) {
  let masked = false;
  let out = text;
  for (const [re, repl] of SENSITIVE) {
    // replace 콜백 인자: (전체, 그룹1, 그룹2, …, 위치, 원문). 함수형 규칙은 앞쪽 그룹만 쓴다.
    out = out.replace(re, (...args) => {
      masked = true;
      return typeof repl === "string" ? repl : repl(...(args as [string, ...string[]]));
    });
  }
  return { text: out, masked };
}

// ── 문장 나누기: 마침표·물음표·줄바꿈, 그리고 "~하고," / "~해서 ~로 가자" 같은 복합문 ──
function splitSentences(text: string): string[] {
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
const MAX_CARDS_PER_AI_MESSAGE = 2; // 목업 전용. ai/syncup_ai/config.py MAX_CARDS_PER_AI_MESSAGE 를 흉내 낸다

// 기한 계산용 날짜 문자열. format.ts 의 ymd 와 같은 형식이지만, 이 파일은 런타임 import 를 둘 수 없어 따로 둔다
const WEEKDAYS = "일월화수목금토";
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "내일", "모레", "금요일", "11월 8일", "11/8" → YYYY-MM-DD (기준: 발화 시각)
function pickDue(s: string, base: Date): string | null {
  const after = (days: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return ymd(d);
  };
  if (/모레/.test(s)) return after(2);
  if (/내일/.test(s)) return after(1);
  if (/오늘/.test(s)) return ymd(base);
  const md = s.match(/(\d{1,2})\s?(?:월|\/)\s?(\d{1,2})/);
  if (md) return ymd(new Date(base.getFullYear(), Number(md[1]) - 1, Number(md[2])));
  const wd = s.match(/([일월화수목금토])요일/);
  if (wd && /까지/.test(s)) return after((WEEKDAYS.indexOf(wd[1]!) - base.getDay() + 7) % 7 || 7);
  return null;
}

// 출처("ChatGPT, 2026-11-06 21:10")의 발화 시각. 날짜만 있으면 정오로 둬서 며칠을 더할 때 서머타임 경계에서 날짜가 밀리지 않게 한다
const baseDate = (source: string) => {
  const m = source.match(/(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/);
  return m ? new Date(`${m[1]}T${m[2] ?? "12:00"}:00`) : new Date();
};

let seq = 0;
const newId = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

// AI 답변은 결정·할 일이 될 수 없음 → 제안 (ai/syncup_ai/classify.py 와 같음)
function tagFor(body: string, speaker: Speaker): Tag | null {
  const tag = pickTag(body);
  return speaker === "ai" && (tag === "decision" || tag === "todo") ? "none" : tag;
}

function subtopicFor(body: string, tag: Tag, enabled: Set<Subtopic> | null): Subtopic | null {
  if (tag === "none") return null;
  const found =
    SUBTOPIC_RULES.find(([, re]) => re.test(body))?.[0] ??
    (tag === "todo" ? "역할·일정" : tag === "research" ? "자료 조사" : "기타");
  return enabled && !enabled.has(found) ? "기타" : found; // 꺼 둔 소주제
}

function topicKeyFor(body: string, tag: Tag): string | null {
  if (tag === "none") return null;
  return TOPIC_RULES.find(([, re]) => re.test(body))?.[0] ?? fallbackTopic(body);
}

function confidenceOf(tag: Tag, owner: string | null, subtopic: Subtopic | null): number {
  let confidence = 0.8;
  if (tag === "todo" && !owner) confidence = 0.5; // 담당 미정 → 확인 필요
  if (subtopic === "기타") confidence -= 0.15;
  return Math.round(confidence * 100) / 100;
}

interface Scope {
  ctx: ClassifyContext;
  known: Set<string>; // 지금까지 나온 세부 주제 (기존 + 이번에 만든 것)
  enabled: Set<Subtopic> | null;
}

type CardBase = Pick<RelatedCard, "id" | "source" | "masked" | "status">;

/** sentence = 가린 문장, body = 단톡방 화자 표시를 뗀 내용, speakerName = 단톡방 줄의 화자 */
function relatedCard(base: CardBase, sentence: string, body: string, tag: Tag, speakerName: string | undefined, scope: Scope): RelatedCard {
  const subtopic = subtopicFor(body, tag, scope.enabled);
  const topic_key = topicKeyFor(body, tag);
  const owner = tag === "decision" || tag === "todo" ? pickOwner(body, tag, scope.ctx, speakerName) : null;
  return {
    ...base,
    relevance: "related",
    sentence,
    subtopic,
    tag,
    topic_key,
    is_new_topic: topic_key ? !scope.known.has(topic_key) : false,
    content: body.replace(/[.?!]+$/, ""),
    reason: null,
    owner,
    due: tag === "todo" ? pickDue(body, baseDate(base.source)) : null,
    is_change: tag === "decision" && CHANGE.test(body),
    confidence: confidenceOf(tag, owner, subtopic),
  };
}

/** 발화 목록 → 후보 카드 (개인 카드 포함. 개인은 sentence 없이 relevance 만) */
export function mockClassify(utterances: Utterance[], ctx: ClassifyContext): Card[] {
  const scope: Scope = {
    ctx,
    known: new Set(ctx.existingTopicKeys ?? []),
    enabled: ctx.enabledSubtopics ? new Set<Subtopic>(ctx.enabledSubtopics) : null,
  };
  const cards: Card[] = [];
  for (const u of utterances) {
    let aiCards = 0;
    for (const raw of splitSentences(u.text)) {
      const { text: sentence, masked } = mask(raw);
      const chat = u.speaker === "user" ? sentence.match(CHAT_LINE) : null;
      const body = chat ? chat[2]! : sentence;
      const personal = PERSONAL.test(body);
      const tag = tagFor(body, u.speaker);
      if (u.speaker === "ai" && !personal) {
        if (tag === null) continue; // AI 답변의 인사·추천 같은 군말은 카드도 개인도 아님
        aiCards += 1;
        if (aiCards > MAX_CARDS_PER_AI_MESSAGE) continue;
      }
      const base = { id: newId(), source: u.source, masked, status: "candidate" as const };
      if (personal || tag === null) {
        cards.push({ ...base, relevance: "personal", confidence: personal ? 0.85 : 0.5 }); // 개인: 문장은 저장하지 않는다
        continue;
      }
      const card = relatedCard(base, sentence, body, tag, chat?.[1], scope);
      if (card.topic_key) scope.known.add(card.topic_key);
      cards.push(card);
    }
  }
  return cards;
}
