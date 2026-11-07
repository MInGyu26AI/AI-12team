// CLAUDE.md §6 데이터 형식 (팀 확정 분류 기준표)

export const SUBTOPICS = [
  "주제·목표",
  "자료 조사",
  "작업·결과물",
  "역할·일정",
  "과제 조건·피드백",
  "발표·제출",
  "기타",
] as const;
export type Subtopic = (typeof SUBTOPICS)[number];

export type Relevance = "related" | "personal";
export type Tag = "decision" | "todo" | "research" | "none"; // none(제안)은 공유 후보에서 제외
export type CardStatus = "candidate" | "approved" | "dismissed";

export interface Card {
  id: string;
  sentence: string | null; // 원문. personal이면 저장 안 함(null)
  relevance: Relevance;
  subtopic: Subtopic;
  tag: Tag;
  topic_key: string; // 같은 topic_key의 decision끼리만 충돌 비교
  is_new_topic: boolean;
  content: string;
  reason: string | null;
  owner: string | null; // 결정자 또는 할 일 담당자
  due: string | null; // YYYY-MM-DD
  is_change: boolean; // 기존 결정을 바꾸는 표현
  source: string; // 예: "ChatGPT, 2026-11-06 21:10"
  masked: boolean; // 민감정보 가림 여부
  confidence: number; // 0~1
  status: CardStatus;
}

export type Judgement = "같음" | "변경" | "충돌";
export type Resolution = "keep-existing" | "adopt-new" | "both-valid";

export interface Conflict {
  id: string;
  topic_key: string;
  cardA: Card; // 기존 결정
  cardB: Card; // 새 결정
  judgement: Judgement;
  reason: string;
  resolution?: Resolution;
  resolutionNote?: string;
}

// 수집 단계의 발화 화자 (Card 에는 저장하지 않음)
export type Speaker = "user" | "ai";
