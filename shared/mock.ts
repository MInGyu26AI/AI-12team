import type { Card, Conflict } from "./types";

export const MOCK_TEAM_CODE = "SYNC-2026";

export const mockCards: Card[] = [
  {
    id: "c1",
    category: "결정",
    topic: "서비스명",
    content: "서비스 이름은 '싱크업(SyncUp)'으로 한다",
    evidence: "user: 이름은 싱크업으로 가자. 팀 싱크 맞춘다는 느낌이 좋아",
    speaker: "user",
    source: "chatgpt-web",
    author: "김단비",
    createdAt: "2026-11-05T10:12:00+09:00",
    status: "approved",
  },
  {
    id: "c2",
    category: "결정",
    topic: "기술 스택",
    content: "팀 웹은 Next.js + Vercel로 배포한다",
    evidence: "user: 웹은 Next.js로 하고 Vercel에 올리자",
    speaker: "user",
    source: "claude-code",
    author: "김동균",
    createdAt: "2026-11-05T14:30:00+09:00",
    status: "approved",
  },
  {
    id: "c3",
    category: "할 일",
    topic: "일정·마감",
    content: "샘플 대화 10개와 정답표 작성",
    evidence: "user: 샘플 대화랑 정답표는 내가 금요일까지 만들게",
    speaker: "user",
    source: "chatgpt-web",
    author: "김민규",
    assignee: "김민규",
    due: "2026-11-07",
    createdAt: "2026-11-06T09:00:00+09:00",
    status: "approved",
  },
  {
    id: "c4",
    category: "제안",
    topic: "핵심 기능",
    content: "Slack 연동으로 결정 알림 보내기",
    evidence: "ai: 결정이 바뀔 때 Slack으로 알림을 보내면 좋을 것 같아요",
    speaker: "ai",
    source: "chatgpt-web",
    author: "김하은",
    createdAt: "2026-11-06T11:20:00+09:00",
    status: "candidate",
  },
  {
    id: "c5",
    category: "결정",
    topic: "서비스명",
    content: "서비스 이름은 '팀메모리'로 한다",
    evidence: "user: 이름 그냥 팀메모리로 하는 게 직관적이지 않아? 그걸로 하자",
    speaker: "user",
    source: "codex",
    author: "김하은",
    createdAt: "2026-11-06T16:45:00+09:00",
    status: "approved",
  },
];

export const mockConflicts: Conflict[] = [
  {
    id: "x1",
    topic: "서비스명",
    cardA: mockCards[0]!,
    cardB: mockCards[4]!,
    judgement: "충돌",
    reason: "같은 주제(서비스명)에 서로 다른 이름이 각각 결정으로 승인됨",
  },
];
