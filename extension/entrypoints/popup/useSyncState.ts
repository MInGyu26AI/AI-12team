import { useEffect, useState } from 'react';
import { syncStateItem, type SyncState } from '@/lib/chatgpt-sync/state';
import { loadSyncProjects, type SyncProjectsResult } from './sync-projects';

// 백그라운드가 저장하는 동기화 상태를 읽고 바뀌면 다시 그린다 (팝업은 읽기만 한다)
export function useSyncState() {
  const [state, setState] = useState<SyncState | null>(null);
  useEffect(() => {
    syncStateItem.getValue().then(setState);
    return syncStateItem.watch(setState);
  }, []);
  return state;
}

export type ProjectsState = { kind: 'loading' } | ({ kind: 'done' } & SyncProjectsResult);

// 프로젝트 고르기 화면을 열 때 한 번 목록을 받는다
export function useSyncProjects(load: () => Promise<SyncProjectsResult> = loadSyncProjects): ProjectsState {
  const [state, setState] = useState<ProjectsState>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    load()
      .catch((): SyncProjectsResult => ({ ok: false, error: '프로젝트 목록을 못 불러왔어요' }))
      .then((result) => alive && setState({ kind: 'done', ...result }));
    return () => {
      alive = false;
    };
  }, [load]);
  return state;
}
