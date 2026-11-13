import { useEffect, useState } from 'react';
import { repoShortName, sinceText, type RepoStatus } from '@shared/repo';
import { repoItem } from '@/lib/repo-status';

// 팝업 하단: "레포 연결됨: AI-12team · 마지막 저장 3분 전". 레포에 연결되지 않은 팀이면 숨긴다
export function RepoFooter() {
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  useEffect(() => {
    repoItem.getValue().then(setRepo);
    return repoItem.watch(setRepo);
  }, []);
  if (!repo?.linked) return null;
  const savedAt = repo.commit?.at ? `마지막 저장 ${sinceText(repo.commit.at)}` : '아직 저장 전';
  const failed = repo.state === 'failed';
  return (
    <p className={`text-center text-xs ${failed ? 'text-sensitive' : 'text-gray-500'}`} title={repo.repo}>
      레포 연결됨: {repoShortName(repo.repo)} · {repo.pending ? '저장 중…' : failed ? '저장 실패' : savedAt}
    </p>
  );
}
