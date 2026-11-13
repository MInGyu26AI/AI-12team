// ChatGPT 대화 JSON(mapping / current_node) 공용 파서. 확장의 탭 클라이언트(계정 동기화)와 웹의 내보내기 파일 읽기가 같이 쓴다.
// 규칙은 docs/sync-contract.md 6장(설계 문서 6장). 이 파일은 약속 고정판이라 타입과 함수 모양만 있다 → 구현은 갈래 3.
import type { SyncWindow } from "./bridge";

// ── 원본 모양 (필요한 필드만, 모두 선택. 모양 검사는 탭 클라이언트가 한다) ──
export interface RawMessage {
  id?: string;
  author?: { role?: string };
  recipient?: string | null;
  create_time?: number | null; // 유닉스 초(소수)
  status?: string;
  end_turn?: boolean | null;
  content?: { content_type?: string; parts?: unknown[] };
  metadata?: {
    is_complete?: boolean;
    finish_details?: { type?: string };
    is_visually_hidden_from_conversation?: boolean;
    is_thinking_preamble_message?: boolean;
    model_dil_v2?: { fallbackMarkdown?: string };
    content_references?: { matched_text?: string }[];
    [key: string]: unknown;
  };
}

export interface RawNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: RawMessage | null;
}

export interface RawConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

// ── 정규화 결과 ──
export interface NormalizedMessage {
  id: string; // ChatGPT message.id (접두사 없음). 확장은 'chatgpt:' 를 붙여 보낸다
  role: "user" | "assistant";
  text: string;
  createdAt: string | null; // ISO. create_time 이 없으면 null
}

// 사용자 메시지 하나와 그 뒤 답변들. 답변 노드가 여러 개여도 합치지 않는다
export interface NormalizedTurn {
  turnId: string; // 사용자 메시지 id. 사용자 메시지 없이 시작하는 앞쪽 답변은 첫 답변 id
  messages: NormalizedMessage[];
  start: string | null; // 턴 안 메시지 시각의 최소 (ISO). 시각 없는 메시지가 있으면 null
  end: string | null; // 최대
  complete: boolean; // 마지막 답변이 끝났는지 (interrupted 도 완료). 답변이 없으면 false
}

export interface NormalizedConversation {
  turns: NormalizedTurn[]; // 대화 순서
  inProgress: boolean; // 마지막 턴의 답변이 생성 중
}

/** 화면에 보이던 줄기를 정규화한다. 빼는 메시지·본문·완료 규칙은 6장. 연결 구조가 돌면 Error */
export function normalizeConversation(conv: RawConversation): NormalizedConversation {
  void conv;
  throw new Error("normalizeConversation: 갈래 3에서 구현");
}

/** 턴 전체가 어느 한 창 안에 있는 완료 턴만 (start ≥ 창 시작, end < 창 끝). 시각 없는 턴은 뺀다 */
export function turnsInWindows(turns: NormalizedTurn[], windows: SyncWindow[]): NormalizedTurn[] {
  void turns;
  void windows;
  throw new Error("turnsInWindows: 갈래 3에서 구현");
}
