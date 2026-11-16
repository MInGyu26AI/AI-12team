import { useEffect, useState } from 'react';
import { repoShortName, type RepoStatus } from '@shared/repo';
import { sendToBackground } from '@/lib/messages';
import type { RepoStatusInfo } from './RepoStatus';

const REPO_POLL_MS = 15_000; // 웹 lib/use-repo.ts 와 같은 간격

/** 팀 상태 파일 GitHub 저장 상태 → 팝업 한 줄 값. 레포에 연결하지 않은 팀이면 null */
export function repoInfoOf(s: RepoStatus | null | undefined): RepoStatusInfo | null {
  if (!s?.linked) return null;
  const state = s.pending ? 'saving' : s.state === 'failed' || s.state === 'blocked' ? s.state : 'saved';
  return { name: repoShortName(s.repo), lastSavedAt: s.commit?.at ?? null, state };
}

// 팝업이 열려 있는 동안 로컬 수집기 RPC team.repo 를 읽는다 (웹 화면과 같은 중계). 실패하면 줄을 숨긴다
export function useRepoStatus() {
  const [info, setInfo] = useState<RepoStatusInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      sendToBackground({ type: 'rpc', method: 'team.repo' })
        .then((r) => alive && setInfo(r?.ok ? repoInfoOf((r.result as { repo?: RepoStatus } | undefined)?.repo) : null))
        .catch(() => alive && setInfo(null));
    void read();
    const timer = setInterval(read, REPO_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return info;
}
