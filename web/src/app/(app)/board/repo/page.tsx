"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { fmtMDHM } from "@shared/format";
import { sinceText } from "@shared/repo";
import { RepoLinkForm, checkOf, isRepoUrl, type RepoCheck } from "@/components/repo-link-form";
import { buttonOutline } from "@/components/ui/surface";
import { USE_MOCK } from "@/lib/api";
import { useRepo } from "@/lib/use-repo";
import { cn } from "@/lib/utils";

// 피그마 7-1: GitHub 레포 연결 (173:3). 팀 결정 기록의 '레포 연결하기'·'연결 관리', 팀 상태 파일의 '레포 연결하기'에서 온다.
// 지금 팀 서버는 레포 연결을 환경변수(SYNCUP_GITHUB_*)로만 정한다. 그래서 실제 모드는 서버가 알려 주는 연결 상태를 이 폼 모양으로 보여 주기만 하고,
// 웹에서 연결·해제하는 기능은 서버가 팀별 토큰을 저장하게 된 뒤에 연다 (서버 설계 초안: 노트 server-analysis-20261115.md 6장)
const LOCKED = "레포 연결과 해제는 아직 팀 서버 설정(관리자)으로만 바꿀 수 있어요. 웹에서 바꾸는 기능은 서버 작업 뒤에 열려요.";

export default function RepoLinkPage() {
  return (
    <div className="mx-auto max-w-[720px] space-y-5 px-gutter py-10">
      <div className="space-y-2">
        <Link href="/board" className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-3.5" aria-hidden />
          팀 결정 기록으로
        </Link>
        <h1 className="text-2xl font-medium sm:text-[28px]">GitHub 레포 연결</h1>
        <p className="text-[13px] text-muted-foreground break-keep">팀 결정과 할 일을 GitHub 레포에도 저장해요. 팀당 한 번만 연결하면 돼요.</p>
      </div>
      {USE_MOCK ? <DemoRepoForm /> : <ServerRepoForm />}
    </div>
  );
}

// 실제 모드: 팀 서버(로컬 수집기 team.repo)가 알려 준 연결 상태를 읽기 전용으로
function ServerRepoForm() {
  const { status, unreachable } = useRepo();
  const commit = status?.linked ? status.commit : null;
  const check: RepoCheck = unreachable && !status ? { state: "error", label: "확인 못 함", detail: "로컬 수집기 연결을 확인해 주세요" } : checkOf(status);
  return (
    <RepoLinkForm
      url={status?.repo ? `github.com/${status.repo}` : ""}
      branch={status?.branch ?? "main"}
      files={status?.files?.length ? status.files : undefined}
      check={check}
      lockedReason={LOCKED}
      footer={
        <>
          <div className="space-y-1">
            <p className="text-[13px] text-muted-foreground">
              {commit?.at ? `마지막 저장  ${fmtMDHM(new Date(commit.at))} · ${sinceText(commit.at)}` : "아직 레포에 저장한 기록이 없어요"}
            </p>
            {commit?.url && (
              <a href={commit.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:underline">
                커밋 {commit.sha.slice(0, 7)}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </div>
          {status?.linked && (
            <button type="button" className={cn(buttonOutline, "h-9 px-4 py-0 text-[13px]")} disabled title={LOCKED}>
              연결 해제
            </button>
          )}
        </>
      }
    />
  );
}

// 목업 모드: 주소 형식만 확인한다. 예시 모드에는 팀 서버가 없어 실제 권한 확인·저장을 하지 않는다고 그대로 알린다
function DemoRepoForm() {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [check, setCheck] = useState<RepoCheck>({ state: "idle" });
  const verify = () =>
    setCheck(
      isRepoUrl(url)
        ? { state: "info", detail: "주소 형식이 맞아요. 예시 모드에는 팀 서버가 없어서 실제 권한 확인과 저장은 하지 않아요." }
        : { state: "error", label: "주소 확인", detail: "github.com/소유자/레포 형식으로 적어 주세요" },
    );
  return <RepoLinkForm url={url} branch={branch} check={check} onUrlChange={(v) => (setUrl(v), setCheck({ state: "idle" }))} onBranchChange={setBranch} onVerify={verify} />;
}
