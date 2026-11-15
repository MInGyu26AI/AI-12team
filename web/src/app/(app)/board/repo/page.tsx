"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { RepoLinkForm, isRepoUrl, type RepoCheck } from "@/components/repo-link-form";
import { USE_MOCK } from "@/lib/api";
import { GithubLinkForm } from "@/components/board/github-link-form";

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
      {USE_MOCK ? <DemoRepoForm /> : <GithubLinkForm />}
    </div>
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
