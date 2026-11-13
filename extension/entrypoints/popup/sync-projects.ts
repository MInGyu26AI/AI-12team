import type { SyncProject } from '@/lib/messages';

export type SyncProjectsResult = { ok: true; projects: SyncProject[] } | { ok: false; error: string };

/**
 * 고를 수 있는 ChatGPT 프로젝트 목록.
 * 팝업이 백그라운드에 목록을 묻는 메시지가 약속(docs/sync-contract.md)에 아직 없다. 정해지면 이 함수 한 곳만 바꾼다.
 */
export async function loadSyncProjects(): Promise<SyncProjectsResult> {
  return { ok: false, error: '프로젝트 목록을 아직 불러올 수 없어요' };
}
