import type { RepoStatus } from "@shared/repo";
import type { Conflict, RelatedCard } from "@shared/types";
import type { ConflictEvent, NotionLinkResult, NotionStatus, TeamApi } from "./types";
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
    getRepo: async () => (await rpc<{ repo: RepoStatus }>("team.repo")).repo,
    getNotion: async () => (await rpc<{ notion: NotionStatus }>("team.notion")).notion,
    verifyNotion: (page, token) => rpc<NotionLinkResult>("team.verifyNotion", notionBody(page, token)),
    linkNotion: (page, token) => rpc<NotionLinkResult>("team.linkNotion", notionBody(page, token)),
    unlinkNotion: async () => (await rpc<{ notion: NotionStatus }>("team.unlinkNotion")).notion,
  };
}

// 토큰을 비우면 보내지 않는다: 서버가 같은 페이지일 때만 저장된 토큰을 다시 쓴다
function notionBody(page: string, token?: string): Record<string, unknown> {
  return token ? { page, token } : { page };
}
