// NEXT_PUBLIC_USE_MOCK=false 면 실제 서버(NEXT_PUBLIC_API_URL), 그 외(기본)는 목업
import { createMockApi } from "./mock";
import { createRealApi } from "./real";
import type { TeamApi } from "./types";

export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK !== "false";

export const api: TeamApi = USE_MOCK
  ? createMockApi()
  : createRealApi(process.env.NEXT_PUBLIC_API_URL ?? "");

export type { ApproveResult, ConflictChoice, TeamApi } from "./types";
