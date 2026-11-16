import { formatAgo, formatClock } from './time-format';

// 팝업 맨 아래 레포 한 줄 (피그마 226:942 "레포 연결됨: AI-12team · 저장 16:17", 누르면 팀 결정 기록으로).
// 값은 useRepoStatus 가 로컬 수집기 team.repo 로 읽는다. 레포에 연결하지 않은 팀이거나 읽지 못하면 null 이고, null 이면 그리지 않는다
export interface RepoStatusInfo {
  name: string;
  lastSavedAt: string | null; // ISO. 아직 한 번도 저장하지 않았으면 null
  state?: 'saved' | 'saving' | 'failed' | 'blocked'; // blocked: 비공개로 연결한 레포가 공개로 바뀌어 저장을 멈춤
}

export function RepoStatus({ repo, onOpen }: { repo: RepoStatusInfo | null | undefined; onOpen?: () => void }) {
  if (!repo) return null;
  const failed = repo.state === 'failed' || repo.state === 'blocked';
  const right =
    repo.state === 'saving' ? '저장 중…' : repo.state === 'blocked' ? '저장 멈춤 (공개로 바뀜)' : failed ? '저장 실패' : repo.lastSavedAt ? `저장 ${formatClock(repo.lastSavedAt)}` : '아직 저장 전';
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="-mx-4 -mb-4 flex w-[calc(100%+2rem)] items-center gap-2 border-t border-card-border bg-[#faf6f0] px-4 py-2.5 text-left text-xs enabled:hover:bg-brand-soft"
    >
      <img src="/github.svg" alt="" width={14} height={14} />
      <span className="font-medium">레포 연결됨: {repo.name}</span>
      <span
        className={`ml-auto text-[11px] ${failed ? 'text-sensitive' : 'text-text-tertiary'}`}
        title={repo.lastSavedAt ? `마지막 저장 ${formatAgo(repo.lastSavedAt)}` : undefined}
      >
        {right}
      </span>
    </button>
  );
}
