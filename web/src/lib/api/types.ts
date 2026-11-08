import type { Conflict, RelatedCard } from "@shared/types";

// 충돌 처리 (피그마 5번): 기존 유지 / 새 결정으로 변경 / 팀에 논의 요청
export type ConflictChoice = "keep-existing" | "adopt-new" | "both-valid" | "discuss";

// 승인 결과: 팀 서버가 /items/approve 에서 하은 님 충돌 판정(python -m syncup_ai conflicts)을 돌려 준다
export interface ApproveResult {
  conflicts: Conflict[]; // 이번에 올린 카드가 기존 결정과 어긋난 것 (cardB = 이번 카드)
}

// CLAUDE.md §8 팀 서버 API. 화면은 이 인터페이스만 쓴다.
export interface TeamApi {
  approveItems(cards: RelatedCard[]): Promise<ApproveResult>; // POST /items/approve
  getBoard(): Promise<RelatedCard[]>; // GET /board
  getConflicts(): Promise<Conflict[]>; // GET /conflicts — 처리 안 된 것 + '논의 요청' 중인 것
  resolveConflict(id: string, choice: ConflictChoice, note?: string): Promise<void>; // POST /conflicts/{id}/resolve
  getDoneTodos(): Promise<string[]>; // GET /todos/done  (TODO: 김동균 님과 형식 확정)
  setTodoDone(id: string, done: boolean): Promise<void>; // POST /items/{id}/done
}
