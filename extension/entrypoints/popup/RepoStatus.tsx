import { formatAgo } from './time-format';

// GitHub 레포 상태 자리 (회의록 10장 "레포 연결됨: AI-12team, 마지막 저장 시각").
// 데이터 출처(GitHub 연동)가 정해질 때까지 null 이고, null 이면 아무것도 그리지 않는다 (docs/sync-contract.md 8장)
export interface RepoStatusInfo {
  name: string;
  lastSavedAt: string; // ISO
}

export function RepoStatus({ repo }: { repo: RepoStatusInfo | null | undefined }) {
  if (!repo) return null;
  return (
    <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
      레포 연결됨: <b className="text-gray-800">{repo.name}</b> · 마지막 저장 {formatAgo(repo.lastSavedAt)}
    </p>
  );
}
