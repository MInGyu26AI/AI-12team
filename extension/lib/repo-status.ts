// 팀 상태 파일 GitHub 저장 상태(로컬 수집기 RPC team.repo)를 확장 저장소에 옮긴다. 팝업 하단 "레포 연결됨: …" 용.
// 수집기에 닿지 못하면 지운다 (옛 상태를 연결된 것처럼 보이지 않게)
import { storage } from '#imports';
import type { RepoStatus } from '@shared/repo';
import { rpc } from './collector-rpc';

export const repoItem = storage.defineItem<RepoStatus | null>('local:repo', { fallback: null });

export async function refreshRepo() {
  try {
    await repoItem.setValue((await rpc<{ repo: RepoStatus }>('team.repo')).repo);
  } catch {
    await repoItem.setValue(null);
  }
}
