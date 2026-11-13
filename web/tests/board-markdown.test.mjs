// 팀 기록 복사(boardToMarkdown): shared/board-markdown.ts 로 옮기기 전(웹 원본)의 출력과 한 글자도 다르지 않아야 한다.
// 기대 문자열은 옮기기 전 web/src/lib/board-markdown.ts 로 같은 입력·같은 날짜를 돌려 얻은 값이다.
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DATE = new Date(NOW).toLocaleDateString("ko-KR"); // 시간대와 상관없이 같은 식으로 만든 날짜

const base = { relevance: "related", status: "approved", source: "ChatGPT, 2026-11-06 21:10", masked: false, confidence: 0.9, is_new_topic: false, reason: null, due: null, is_change: false };
const cards = [
  { ...base, id: "d1", sentence: "x", subtopic: "작업·결과물", tag: "decision", topic_key: "MVP 범위", content: "브라우저 확장 = MVP 포함", owner: "이서준" },
  { ...base, id: "d2", sentence: "x", subtopic: "작업·결과물", tag: "decision", topic_key: "MVP 범위", content: "브라우저  확장 = MVP  포함", owner: "이서준" }, // 공백만 다른 중복
  { ...base, id: "t1", sentence: "x", subtopic: "작업·결과물", tag: "todo", topic_key: "배포", content: "Vercel 배포", owner: "김단비", due: "2026-11-15" },
  { ...base, id: "t2", sentence: "x", subtopic: "역할·일정", tag: "todo", topic_key: null, content: "발표 자료 준비", owner: null },
  { ...base, id: "r1", sentence: "x", subtopic: "자료 조사", tag: "research", topic_key: "경쟁 서비스", content: "Notion AI는 팀 메모리가 없음", owner: null },
  { ...base, id: "d3", sentence: "x", subtopic: "작업·결과물", tag: "decision", topic_key: "배포", content: "웹은 Vercel에 배포", owner: null },
  { ...base, id: "d4", sentence: "x", subtopic: null, tag: "decision", topic_key: null, content: "팀 이름은 싱크업", owner: "김민규" },
];
const conflicts = [{ id: "c1", topic_key: "MVP 범위", cardA: cards[0], cardB: { ...cards[0], id: "d9", content: "브라우저 확장은 MVP 제외" }, judgement: "충돌", reason: "r" }];

const EXPECTED = `# 싱크업 팀 기록 (${DATE})

아래는 우리 팀이 지금까지 합의한 내용입니다. 이 내용을 전제로 답해 주세요.

## 자료 조사
- [조사] 경쟁 서비스: Notion AI는 팀 메모리가 없음

## 작업·결과물
- [결정] MVP 범위: 브라우저 확장 = MVP 포함 (결정 이서준)
- [할 일] 배포: Vercel 배포 (담당 김단비, 기한 2026-11-15)
- [결정] 배포: 웹은 Vercel에 배포

## 역할·일정
- [할 일] 발표 자료 준비 (담당 미정, 기한 미정)

## 기타
- [결정] 팀 이름은 싱크업 (결정 김민규)

## 아직 정리되지 않은 충돌
- MVP 범위: "브라우저 확장 = MVP 포함" vs "브라우저 확장은 MVP 제외"`;

const EXPECTED_EMPTY = `# 싱크업 팀 기록 (${DATE})

아래는 우리 팀이 지금까지 합의한 내용입니다. 이 내용을 전제로 답해 주세요.`;

test("옮긴 boardToMarkdown 의 출력이 옮기기 전과 같다", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { boardToMarkdown } = load("@shared/board-markdown");
  assert.equal(boardToMarkdown(cards, conflicts), EXPECTED);
  assert.equal(boardToMarkdown([], []), EXPECTED_EMPTY);
});

test("웹의 board-markdown 은 공용 함수를 그대로 다시 내보낸다", () => {
  const shared = load("@shared/board-markdown");
  const web = load("@/lib/board-markdown");
  assert.equal(web.boardToMarkdown, shared.boardToMarkdown);
});
