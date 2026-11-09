import type { Conflict, RelatedCard } from "@shared/types";
import type { ConflictEvent, TeamApi } from "./types";
import { rpc } from "../rpc";

export function createRealApi(): TeamApi {
  return {
    // 내용 수정은 검토 화면이 candidates.update 로 이미 저장했다. teamId 는 화면에 보인 팀이라 그사이 팀이 바뀌면 수집기가 거절한다
    approveItems: async (cards, teamId) => {
      await rpc("candidates.approve", { ids: cards.map((c) => c.id), teamId });
      return { conflicts: [] };
    },
    getBoard: async () => (await rpc<{ items: RelatedCard[] }>("team.board")).items,
    getConflicts: async () => (await rpc<{ conflicts: Conflict[] }>("team.conflicts")).conflicts,
    resolveConflict: async (id, resolution, resolutionNote) => {
      await rpc("team.resolve", { id, resolution, resolutionNote });
    },
    getDoneTodos: async () => (await rpc<{ ids: string[] }>("team.done")).ids,
    setTodoDone: async (id, done) => {
      await rpc("team.setDone", { id, done });
    },
    retryCheck: async (id) => {
      await rpc("team.retryCheck", { id });
    },
    getHistory: async () => {
      const [history, log] = await Promise.all([
        rpc<{ items: RelatedCard[] }>("team.history"),
        rpc<{ events: ConflictEvent[] }>("team.conflictHistory"),
      ]);
      return { records: history.items, events: log.events };
    },
  };
}
