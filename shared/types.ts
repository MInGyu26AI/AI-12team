// CLAUDE.md §6 데이터 형식. 하은님·동균님과 확정되면 여기만 고친다.

export const CATEGORIES = ["결정", "조사", "할 일", "제안", "개인"] as const;
export type Category = (typeof CATEGORIES)[number];

export const TOPICS = [
  "서비스명",
  "타깃 사용자",
  "핵심 기능",
  "MVP 범위",
  "기술 스택",
  "역할 분담",
  "일정·마감",
  "발표 구성",
  "기타",
] as const;
export type Topic = (typeof TOPICS)[number];

export type Speaker = "user" | "ai";
export type Source = "chatgpt-web" | "codex" | "claude-code" | "paste" | "export";
export type CardStatus = "candidate" | "approved" | "dismissed";

export interface Card {
  id: string;
  category: Category;
  topic: Topic;
  content: string; // 핵심 내용 요약
  evidence: string; // 대화 원문 발췌
  speaker: Speaker; // 근거 문장의 화자
  source: Source;
  author: string; // 팀원 이름
  assignee?: string; // 할 일일 때
  due?: string; // 할 일일 때
  createdAt: string;
  status: CardStatus;
}

export type Judgement = "같음" | "변경" | "충돌";
export type Resolution = "keep-existing" | "adopt-new" | "both-valid";

export interface Conflict {
  id: string;
  topic: string;
  cardA: Card;
  cardB: Card;
  judgement: Judgement;
  reason: string;
  resolution?: Resolution;
  resolutionNote?: string;
}
