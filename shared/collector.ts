// 로컬 수집기에 들어가는 발화 모양, Native Messaging host 이름, 로컬 RPC 버전.
// 확장·웹 → 로컬 수집기는 { version, method, params } RPC 다 (extension/lib/collector-rpc.ts, web/src/lib/rpc.ts).
import type { ClassificationOutput, Subtopic } from "./types";

export const NATIVE_HOST = "com.syncup.collector";
export const LOCAL_RPC_VERSION = 1;

// 수집한 발화 한 건 (turns.append). site 는 turn_intake.clean_message 가 받는 값 (INTAKE_SITES)
export interface CollectedMessage {
  id: string; // 사이트의 메시지 id (없으면 내용 해시)
  site: "chatgpt" | "manual" | "chatgpt-export"; // manual = 붙여넣기, chatgpt-export = 내보내기 파일
  role: "user" | "assistant";
  roleGuessed?: boolean; // 화면에서 화자를 못 읽어 순서로 추정했거나, 드래그 선택이라 사용자로 간주한 경우
  text: string;
  conversationId: string;
  conversationTitle?: string;
  url?: string;
  collectedAt: string; // ISO
}

// `python -m syncup_ai classify` 표준 입력 (ai/README.md). TS 코드는 쓰지 않고 ai/ 가 이 이름으로 형식을 가리킨다
export interface NativeClassifyRequest {
  type: "classify";
  version: typeof LOCAL_RPC_VERSION;
  context: {
    teamName: string;
    projectTopic: string;
    userName: string;
    enabledSubtopics: Subtopic[];
    existingTopicKeys: string[];
  };
  messages: CollectedMessage[];
}

// `python -m syncup_ai classify` 표준 출력. cards 는 docs/classification.md 4장 출력 형식(JSON) 그대로
export type NativeClassifyResponse =
  | { ok: true; cards: ClassificationOutput[] }
  | { ok: false; error: string };
