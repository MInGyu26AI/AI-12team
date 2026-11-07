// 확장 프로그램 ↔ 김동균 님 Mac 로컬 수집기(Native Messaging host) 메시지 형식.
// TODO(2026-11-08): 내일 김동균 님과 맞출 것 — 호스트 이름, 필드 이름, 오류 형식, 버전 규칙.
import type { ClassificationOutput, Subtopic } from "./types";

export const NATIVE_HOST = "com.syncup.collector";
export const NATIVE_PROTOCOL_VERSION = 1;

// 콘텐츠 스크립트가 화면에서 읽은 메시지 한 건
export interface CollectedMessage {
  id: string; // 사이트의 메시지 id (없으면 내용 해시)
  site: "chatgpt"; // 사이트 추가 시 늘림 (예: "claude")
  role: "user" | "assistant";
  text: string;
  conversationId: string;
  conversationTitle: string;
  url: string;
  collectedAt: string; // ISO
}

// 확장 → 로컬 수집기
export interface NativeClassifyRequest {
  type: "classify";
  version: typeof NATIVE_PROTOCOL_VERSION;
  context: {
    teamName: string;
    projectTopic: string;
    userName: string;
    enabledSubtopics: Subtopic[];
    existingTopicKeys: string[];
  };
  messages: CollectedMessage[];
}

// 로컬 수집기 → 확장. cards 는 docs/classification.md 4장 출력 형식(JSON) 그대로
export type NativeClassifyResponse =
  | { ok: true; cards: ClassificationOutput[] }
  | { ok: false; error: string };
