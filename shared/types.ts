// CLAUDE.md §6 / docs/classification.md 4장 출력 형식(JSON)

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

// 분류 AI가 내보내는 JSON 한 건
interface CommonOutput {
  source: string; // 예: "ChatGPT, 2026-11-06 21:10"
  masked: boolean; // 민감정보를 가렸는지
  confidence: number; // 0~1. 0.6 미만이면 확인 필요
}

export interface RelatedOutput extends CommonOutput {
  classificationMethod?: "chat" | "decisions" | "manual" | "demo";
  evidence?: { messageId: string; role: "user" | "assistant"; roleGuessed: boolean; quote: string };
  deliveryState?: "pending" | "sent" | "blocked";
  decisionState?: "active" | "review" | "superseded" | "rejected";
  conflictCheckStatus?: "pending" | "running" | "complete" | "failed" | "not-required";
  conflictCheckProgress?: { total: number; completed: number; skipped: number } | null;
  conflictCheckDetail?: string;
  approvedBy?: string;
  approvedAt?: number;
  relevance: "related";
  sentence: string; // 원문 문장(또는 나눈 일부)
  subtopic: Subtopic | null; // tag=none(제안)이면 null 가능
  tag: Tag;
  topic_key: string | null; // 세부 주제. 같은 topic_key의 decision끼리만 충돌 비교. tag=none이면 null 가능
  is_new_topic: boolean;
  content: string;
  reason: string | null;
  owner: string | null; // 결정자 또는 할 일 담당자
  due: string | null; // YYYY-MM-DD
  is_change: boolean; // 기존 결정을 바꾸는 표현인지
}

// 개인은 sentence 등 내용을 저장하지 않고 relevance만 남김
export interface PersonalOutput extends CommonOutput {
  relevance: "personal";
}

export type ClassificationOutput = RelatedOutput | PersonalOutput;

// 앱에서 덧붙이는 필드
interface AppFields {
  id: string;
  status: CardStatus;
}
export type RelatedCard = RelatedOutput & AppFields;
export type PersonalCard = PersonalOutput & AppFields;
export type Card = RelatedCard | PersonalCard;

// ai/syncup_ai/conflict.py JUDGEMENTS 와 같음. 경고로 보내는 것은 충돌(+ CONFLICT_ON_CHANGE 면 변경)
export type Judgement = "같음" | "변경" | "충돌" | "무관";
// discuss = 팀에 논의 요청 (결정을 보류하고 경고를 보드에 남김, 피그마 5번 화면)
export type Resolution = "keep-existing" | "adopt-new" | "both-valid" | "discuss";

export interface Conflict {
  id: string;
  topic_key: string;
  cardA: RelatedCard; // 기존 결정
  cardB: RelatedCard; // 새 결정
  judgement: Judgement;
  reason: string;
  confidence?: number;
  method?: "decisions" | "chat" | "rule";
  resolution?: Resolution;
  resolutionNote?: string;
}

// 수집 단계의 발화 화자 (Card 에는 저장하지 않음)
export type Speaker = "user" | "ai";
