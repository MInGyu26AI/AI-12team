// NEXT_PUBLIC_USE_MOCK=true 일 때만 목업. 그 외(기본)는 실제 모드: 로컬 수집기 RPC로 팀 서버에 접근한다 (확장 경유, NEXT_PUBLIC_LOCAL_BRIDGE=true 면 웹 서버의 /api/local 경유)
import { createMockApi } from "./mock";
import { createRealApi } from "./real";
import type { TeamApi } from "./types";

export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

export const api: TeamApi = USE_MOCK
  ? createMockApi()
  : createRealApi();

export type { ApproveResult, ConflictChoice, TeamApi } from "./types";
