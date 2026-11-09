import type { Conflict, RelatedCard, Resolution } from "@shared/types";

// 승인 결과. 실제 모드는 팀 서버가 전송을 받은 뒤 충돌을 검사하므로 늘 빈 목록이고(보드의 검사 진행·충돌 배너로 확인),
// 목업 모드만 바로 판정해 돌려준다.
export interface ApproveResult {
  conflicts: Conflict[]; // 이번에 올린 카드가 기존 결정과 어긋난 것 (cardB = 이번 카드)
}

// 충돌 처리 이력 한 건 (팀 서버 conflicts/history 의 events)
export interface ConflictEvent {
  resolution: Resolution | "obsolete";
  note: string;
  at: string;
}

export interface DecisionHistory {
  records: RelatedCard[]; // 보드에서 내려간 결정까지 포함한 전체 결정 (decisionState 로 구분)
  events: ConflictEvent[];
}

// 팀 결정 기록 API. 목업(mock.ts)은 이 브라우저에 저장하고, 실제(real.ts)는 로컬 수집기 RPC 로 팀 서버에 닿는다.
// 주석의 이름은 real.ts 가 부르는 RPC 메서드다.
export interface TeamApi {
  approveItems(cards: RelatedCard[], teamId: string | undefined): Promise<ApproveResult>; // candidates.approve
  getBoard(): Promise<RelatedCard[]>; // team.board
  getConflicts(): Promise<Conflict[]>; // team.conflicts — 처리 안 된 것 + '논의 요청' 중인 것
  resolveConflict(id: string, choice: Resolution, note?: string): Promise<void>; // team.resolve
  getDoneTodos(): Promise<string[]>; // team.done
  setTodoDone(id: string, done: boolean): Promise<void>; // team.setDone
  retryCheck(id: string): Promise<void>; // team.retryCheck — 멈춘 충돌 검사의 남은 비교를 다시 시작
  getHistory(): Promise<DecisionHistory>; // team.history + team.conflictHistory
}
