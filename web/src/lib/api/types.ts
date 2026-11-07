import type { Conflict, RelatedCard } from "@shared/types";

// 충돌 해결 선택: 앞의 결정 유지 / 새 결정으로 변경
export type ConflictChoice = "keep-existing" | "adopt-new";

// CLAUDE.md §8 팀 서버 API. 화면은 이 인터페이스만 쓴다.
export interface TeamApi {
  approveItems(cards: RelatedCard[]): Promise<void>; // POST /items/approve
  getBoard(): Promise<RelatedCard[]>; // GET /board
  getConflicts(): Promise<Conflict[]>; // GET /conflicts
  resolveConflict(id: string, choice: ConflictChoice, note?: string): Promise<void>; // POST /conflicts/{id}/resolve
}
