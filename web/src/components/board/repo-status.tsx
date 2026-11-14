"use client";

import { GitBranch } from "lucide-react";
import { repoLine, type RepoStatus, type RepoTone } from "@shared/repo";
import { cn } from "@/lib/utils";

const TONE: Record<RepoTone, string> = {
  ok: "border-ok/30 bg-ok-soft text-ok",
  busy: "border-brand/30 bg-brand-soft text-brand",
  error: "border-alert-conflict/30 bg-alert-conflict-soft text-alert-conflict",
  muted: "border-border bg-muted text-muted-foreground",
};

// 팀 보드 맨 위(충돌 배너 아래) 레포 상태 바: "AI-12team · 레포에 저장됨 ✓ · 3분 전 · 커밋 a1b2c3d". 연결 안 된 팀이면 숨김
export function RepoStatusBar({ status, unreachable }: { status: RepoStatus | null; unreachable: boolean }) {
  const line = repoLine(status);
  if (!line) {
    if (!unreachable || status) return null;
    return (
      <p className={cn("flex items-center gap-2 rounded-lg border px-4 py-2 text-sm", TONE.muted)}>
        <GitBranch className="size-4 shrink-0" />
        레포 연결 상태를 확인할 수 없어요 · 로컬 수집기 연결을 확인해 주세요
      </p>
    );
  }
  const commit = status?.commit;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-4 py-2 text-sm font-medium", TONE[line.tone])}>
      <GitBranch className="size-4 shrink-0" />
      <span className="break-keep">{line.text}</span>
      {commit?.url && (
        <a href={commit.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          커밋 {commit.sha.slice(0, 7)}
        </a>
      )}
    </p>
  );
}

// 팀 설정(대화 수집 화면)에 보이는 레포 연결 상태. 연결은 팀 서버 환경 변수로만 정해져서 여기서 바꾸지 않는다
export function RepoLinkRow({ status }: { status: RepoStatus | null }) {
  if (!status) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <GitBranch className="size-4 text-muted-foreground" />
      <span className="font-medium">GitHub 레포</span>
      {status.linked ? (
        <span className="text-ok">
          연결됨 · {status.repo} ({status.branch})
        </span>
      ) : (
        <span className="text-muted-foreground break-keep">연결 안 됨 · 레포 연결은 팀 서버 관리자가 서버 설정으로 정해요</span>
      )}
    </div>
  );
}
