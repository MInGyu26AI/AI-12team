// 팀 결정 기록 API 진입점. NEXT_PUBLIC_USE_MOCK=true 일 때만 목업(이 브라우저에 저장).
// 그 외(기본)는 실제 모드: 로컬 수집기 RPC 로 팀 서버에 닿는다 (확장 경유, NEXT_PUBLIC_LOCAL_BRIDGE=true 면 웹 서버의 /api/local 경유)
import { createMockApi } from "./mock";
import { createRealApi } from "./real";
import type { TeamApi } from "./types";

export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

// 팀 결정 기록과 로컬 수집기 상태를 다시 읽는 주기
export const POLL_MS = 5000;

export const api: TeamApi = USE_MOCK
  ? createMockApi()
  : createRealApi();

/** 팀 보드에 있는 세부 주제 이름 (분류에서 기존 이름을 먼저 쓰고, 승인함에서 새 주제인지 판단할 때) */
export async function boardTopicKeys(): Promise<Set<string>> {
  const board = await api.getBoard();
  return new Set(board.map((c) => c.topic_key).filter((k): k is string => !!k));
}

export type { DecisionHistory } from "./types";
