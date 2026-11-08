import type { Conflict, RelatedCard } from '@shared/types';
import type { ExtStatus } from '@shared/bridge';
import type { TeamApi } from './types';
import { rpc } from '../rpc';

export function createRealApi(): TeamApi {
  return {
    approveItems: async (cards) => {
      const status = await rpc<ExtStatus>('collection.status');
      for (const card of cards) await rpc('candidates.update', { id: card.id, patch: { content: card.content } });
      await rpc('candidates.approve', { ids: cards.map(c => c.id), teamId: status.teamId });
      return { conflicts: [] };
    },
    getBoard: async () => (await rpc<{items: RelatedCard[]}>('team.board')).items,
    getConflicts: async () => (await rpc<{conflicts: Conflict[]}>('team.conflicts')).conflicts,
    resolveConflict: async (id, resolution, resolutionNote) => { await rpc('team.resolve', { id, resolution, resolutionNote }); },
    getDoneTodos: async () => (await rpc<{ids: string[]}>('team.done')).ids,
    setTodoDone: async (id, done) => { await rpc('team.setDone', { id, done }); },
  };
}
