import { sendToBackground, type SyncProject } from '@/lib/messages';

export type SyncProjectsResult = { ok: true; projects: SyncProject[] } | { ok: false; error: string };

/**
 * 고를 수 있는 ChatGPT 프로젝트 목록 (BgRequest syncProjects, docs/sync-contract.md 5장).
 * 동기화가 꺼져 있어도 부를 수 있다(켜기 전에 고르므로). 실패 문구는 받은 그대로 돌려준다
 */
export async function loadSyncProjects(): Promise<SyncProjectsResult> {
  const response = await sendToBackground({ type: 'syncProjects' }).catch(() => null);
  if (!response?.ok) return { ok: false, error: response?.error ?? '프로젝트 목록을 못 불러왔어요' };
  if (!Array.isArray(response.result)) return { ok: false, error: '프로젝트 목록을 받지 못했어요' };
  return { ok: true, projects: response.result as SyncProject[] };
}
