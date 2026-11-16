"use client";

import Image from "next/image";
import { Check, CircleX, FileText, LoaderCircle } from "lucide-react";
import type { RepoStatus } from "@shared/repo";
import { buttonPrimary, input } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// GitHub 레포 연결 폼 (피그마 7-1 173:42 · 2-2 174:47 같은 카드). 화면마다 아래 줄(footer)과 동작만 다르다.
// 지금 팀 서버는 레포 연결을 환경변수(SYNCUP_GITHUB_*)로만 정하므로, 실제 모드에서는 값을 보여 주기만 하고 입력을 잠근다 (lockedReason)

export type RepoCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; label: string; detail: string }
  | { state: "error"; label: string; detail: string }
  | { state: "info"; detail: string };

const DEFAULT_FILES = ["SYNCUP.md", "syncup.json"];
const FILE_NOTE: Record<string, string> = {
  "SYNCUP.md": "사람이 읽는 팀 결정·할 일 정리",
  "syncup.json": "코딩 AI가 읽는 같은 내용",
};

export function RepoLinkForm({ url, branch, files = DEFAULT_FILES, check, lockedReason, onUrlChange, onBranchChange, onVerify, footer }: {
  url: string;
  branch: string;
  files?: string[];
  check: RepoCheck;
  lockedReason?: string; // 있으면 입력·'연결 확인'을 잠그고 이 이유를 보여 준다
  onUrlChange?: (v: string) => void;
  onBranchChange?: (v: string) => void;
  onVerify?: () => void;
  footer?: React.ReactNode;
}) {
  const locked = !!lockedReason;
  return (
    <section className="overflow-hidden rounded-[14px] border border-foreground/8 bg-white" aria-labelledby="repo-form-title">
      <div className="flex items-center gap-2.5 px-6 py-5">
        <Image src="/brand/github.svg" alt="" width={20} height={20} unoptimized />
        <div className="space-y-0.5">
          <h2 id="repo-form-title" className="text-[17px] font-bold">
            연결할 레포
          </h2>
          <p className="text-xs text-text-tertiary break-keep">팀 레포 1개에만 권한을 준 토큰으로 연결해요. 토큰은 팀 서버에만 보관돼요.</p>
        </div>
      </div>
      <div className="h-px bg-foreground/8" />
      <div className="space-y-4 px-6 py-5">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">레포 주소</span>
          <span className="flex gap-2">
            <input
              value={url}
              readOnly={locked}
              onChange={(e) => onUrlChange?.(e.target.value)}
              placeholder="github.com/팀/레포"
              aria-label="레포 주소"
              className={input}
            />
            <button
              type="button"
              className={cn(buttonPrimary, "h-10 px-4 py-0 text-[13px]")}
              disabled={locked || !url.trim() || check.state === "checking"}
              onClick={onVerify}
              title={lockedReason}
            >
              연결 확인
            </button>
          </span>
        </label>
        <CheckLine check={check} />
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">저장 브랜치</span>
          <input value={branch} readOnly={locked} onChange={(e) => onBranchChange?.(e.target.value)} aria-label="저장 브랜치" className={input} />
          <span className="block text-xs text-text-tertiary">SyncUp은 이 브랜치에만 커밋해요.</span>
        </label>
        <div className="space-y-1.5">
          <p className="text-[13px] font-medium">저장할 파일</p>
          {files.map((f) => (
            <p key={f} className="flex items-center gap-2">
              <FileText className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="font-mono text-[13px]">{f}</span>
              {FILE_NOTE[f] && <span className="text-xs text-text-tertiary">{FILE_NOTE[f]}</span>}
            </p>
          ))}
          <p className="text-xs text-text-tertiary">두 파일은 SyncUp만 고쳐요. 직접 고치면 다음 저장 때 덮어써져요.</p>
        </div>
        {lockedReason && <p className="rounded-md bg-surface-soft px-3 py-2 text-xs text-muted-foreground break-keep">{lockedReason}</p>}
      </div>
      {footer && (
        <>
          <div className="h-px bg-foreground/8" />
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">{footer}</div>
        </>
      )}
    </section>
  );
}

// 연결 상태 한 줄 (피그마 226:798 '2. 레포 연결 상태'): 확인 중 · 연결됨 · 권한 없음. 빨강은 실패에만
function CheckLine({ check }: { check: RepoCheck }) {
  if (check.state === "idle") return null;
  if (check.state === "checking")
    return (
      <p role="status" className="flex items-center gap-2 rounded-md bg-brand-soft/50 px-3 py-2.5 text-[13px]">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <b className="font-medium">확인 중</b>
        <span className="text-xs text-muted-foreground">레포와 권한을 확인하고 있어요</span>
      </p>
    );
  if (check.state === "error")
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-alert-conflict/40 px-3 py-2.5 text-[13px]">
        <CircleX className="size-4 text-alert-conflict" aria-hidden />
        <b className="font-medium text-alert-conflict">{check.label}</b>
        <span className="text-xs text-muted-foreground break-keep">{check.detail}</span>
      </p>
    );
  if (check.state === "info") return <p className="rounded-md bg-brand-soft/50 px-3 py-2.5 text-xs text-muted-foreground break-keep">{check.detail}</p>;
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-brand-soft/50 px-3 py-2.5 text-[13px]">
      <Check className="size-4 text-ok" aria-hidden />
      <b className="font-medium">{check.label}</b>
      <span className="text-xs text-muted-foreground break-keep">· {check.detail}</span>
    </p>
  );
}

/** 팀 서버가 알려 준 레포 저장 상태 → 폼의 연결 상태 한 줄 */
export function checkOf(status: RepoStatus | null): RepoCheck {
  if (!status) return { state: "checking" };
  if (!status.linked) return { state: "info", detail: "아직 연결된 레포가 없어요." };
  if (status.pending) return { state: "checking" };
  if (status.state === "failed")
    return {
      state: "error",
      label: "저장 실패",
      detail: `권한이 없거나 연결이 끊겼어요${status.httpStatus ? ` (HTTP ${status.httpStatus})` : ""}. 팀장에게 토큰 권한을 확인해 달라고 하세요`,
    };
  if (status.state === "saved" || status.state === "unchanged") return { state: "ok", label: "연결됨", detail: "팀 서버가 이 레포에 저장하고 있어요" };
  return { state: "ok", label: "연결됨", detail: "첫 저장을 기다리는 중이에요" };
}

/** github.com/소유자/레포 형식인지 (https:// 와 끝의 / · .git 은 허용) */
export const isRepoUrl = (v: string) => /^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/i.test(v.trim());
