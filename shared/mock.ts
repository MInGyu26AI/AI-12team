import type { Card, Conflict } from "./types";

export const MOCK_TEAM_CODE = "SYNC-2026";

const base = { relevance: "related", is_new_topic: true, reason: null, owner: null, due: null, is_change: false, masked: false } as const;

export const mockCards: Card[] = [
  {
    ...base,
    id: "c1",
    sentence: "서비스명은 싱크업으로 정했어",
    subtopic: "주제·목표",
    tag: "decision",
    topic_key: "서비스명",
    content: "서비스명은 '싱크업'",
    owner: "김단비",
    source: "ChatGPT, 2026-11-05 14:20",
    confidence: 0.95,
    status: "approved",
  },
  {
    ...base,
    id: "c2",
    sentence: "타깃은 대학생으로 가자",
    subtopic: "주제·목표",
    tag: "decision",
    topic_key: "타깃 사용자",
    content: "타깃 사용자는 대학생",
    owner: "김민규",
    source: "ChatGPT, 2026-11-05 15:02",
    confidence: 0.9,
    status: "approved",
  },
  {
    // 충돌 데모용 기존 결정 (예시 문장 목록 외에 추가)
    ...base,
    id: "c0",
    sentence: "MVP는 팀 웹만 먼저 만들자",
    subtopic: "작업·결과물",
    tag: "decision",
    topic_key: "MVP 범위",
    content: "MVP는 팀 웹만",
    owner: "김동균",
    source: "Claude Code, 2026-11-05 20:40",
    confidence: 0.85,
    status: "approved",
  },
  {
    ...base,
    id: "c3",
    sentence: "브라우저 확장도 MVP에 넣자",
    subtopic: "작업·결과물",
    tag: "decision",
    topic_key: "MVP 범위",
    is_new_topic: false,
    content: "MVP에 브라우저 확장 포함",
    reason: "비개발자도 설치 부담 없이 자동 수집하려면 확장이 필요",
    owner: "김단비",
    is_change: true,
    source: "ChatGPT, 2026-11-06 21:10",
    confidence: 0.82,
    status: "approved",
  },
  {
    ...base,
    id: "c4",
    sentence: "분류 기준표는 내가 내일까지 만들게",
    subtopic: "역할·일정",
    tag: "todo",
    topic_key: "분류 기준표",
    content: "분류 기준표 작성",
    owner: "김민규",
    due: "2026-11-07",
    source: "ChatGPT, 2026-11-06 21:25",
    confidence: 0.88,
    status: "approved",
  },
  {
    ...base,
    id: "c5",
    sentence: "ChatGPT 공유 프로젝트는 유료 팀 플랜이 필요하대",
    subtopic: "자료 조사",
    tag: "research",
    topic_key: "ChatGPT 공유 기능",
    content: "ChatGPT 공유 프로젝트는 유료 팀 플랜 필요",
    source: "ChatGPT, 2026-11-06 22:03",
    confidence: 0.55, // → "확인 필요" 배지
    status: "candidate",
  },
  {
    ...base,
    id: "c6",
    sentence: "발표 자료는 [연락처]로 보내 줘",
    subtopic: "발표·제출",
    tag: "todo",
    topic_key: "발표 자료 전달",
    content: "발표 자료를 지정 연락처로 전달",
    masked: true,
    source: "ChatGPT, 2026-11-07 10:15",
    confidence: 0.7,
    status: "candidate",
  },
  {
    ...base,
    id: "c7",
    sentence: "주제를 청년 주거로 하면 어때?",
    subtopic: "주제·목표",
    tag: "none", // 제안 → 공유 후보에서 제외, 검토함에서 회색
    topic_key: "서비스 주제",
    content: "주제를 청년 주거로 제안",
    source: "ChatGPT, 2026-11-07 11:30",
    confidence: 0.65,
    status: "candidate",
  },
];

const byId = (id: string) => mockCards.find((c) => c.id === id)!;

export const mockConflicts: Conflict[] = [
  {
    id: "x1",
    topic_key: "MVP 범위",
    cardA: byId("c0"),
    cardB: byId("c3"),
    judgement: "변경",
    reason: "같은 topic_key(MVP 범위)의 기존 결정 '팀 웹만'을 '브라우저 확장 포함'으로 바꾸는 표현",
  },
];
