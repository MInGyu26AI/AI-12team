"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { USE_MOCK } from "@/lib/api";
import { WebAccountContext } from "@/lib/account-context";
import type { Account } from "@/lib/auth-navigation";
import { DashboardContext, type PcState } from "./context";
import { CreateTeamDialog } from "./create-team-dialog";
import { FlowSlidesDialog } from "./flow-slides";
import { Sidebar } from "./sidebar";

// PC 연결 슬라이드(설치 캡처 이미지 포함)는 열 때만 불러온다: 첫 화면을 가볍게 하고, 접근 확인 시험이 Node 에서 이 틀을 불러와도 이미지 모듈을 끌어오지 않게
const InstallSlidesDialog = dynamic(() => import("./install-slides").then((m) => m.InstallSlidesDialog), { ssr: false });

type Dialog = "install" | "flow" | "team" | null;

/**
 * 로그인 후 틀: 헤더(로고 · 프로필) + 왼쪽 사이드바 + 본문. 팝업(PC 연결하기 · 이용 방법 · 팀 만들기)은 여기서 한 번만 연다.
 * .app-shell 안에서만 글꼴·옅은 테두리가 바뀐다 (globals.css). setup 화면(팀 만들기·초대 참여)은 사이드바 없이
 */
export function DashboardShell({ account, pc, recheck, setup, children }: {
  account: Account | null;
  pc: PcState;
  recheck: () => void;
  setup: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const value = useMemo(() => ({
    account,
    pc,
    recheck,
    openInstall: () => setDialog("install"),
    openFlow: () => setDialog("flow"),
    openCreateTeam: () => (USE_MOCK ? router.push("/team/new") : setDialog("team")),
  }), [account, pc, recheck, router]);
  const close = () => setDialog(null);

  return (
    <DashboardContext.Provider value={value}>
      <WebAccountContext.Provider value={account}>
        <div className="app-shell flex min-h-full flex-1 flex-col bg-canvas">
          <AppHeader />
          <div className="flex flex-1 flex-col md:flex-row">
            {!setup && <Sidebar />}
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </div>
        <InstallSlidesDialog open={dialog === "install"} onClose={close} />
        <FlowSlidesDialog open={dialog === "flow"} onClose={close} onCreateTeam={value.openCreateTeam} onOpenInstall={() => setDialog("install")} />
        {account && (
          <CreateTeamDialog
            open={dialog === "team"}
            name={account.name}
            onClose={close}
            onCreated={() => { recheck(); setDialog("install"); }}
          />
        )}
      </WebAccountContext.Provider>
    </DashboardContext.Provider>
  );
}
