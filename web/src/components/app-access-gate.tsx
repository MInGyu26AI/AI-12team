"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ExtStatus } from "@shared/bridge";
import { Brand } from "./brand";
import { LogoutButton } from "./logout-button";
import { DashboardShell } from "./dashboard/shell";
import type { PcState } from "./dashboard/context";
import { PcRequiredPanel } from "./dashboard/pc-required";
import { buttonOutline, card } from "./ui/surface";
import { USE_MOCK } from "@/lib/api";
import { connectionProblem, loginUrl, readAccount, type Account } from "@/lib/auth-navigation";
import { refreshCollector, useCollectorStatus } from "@/lib/local-collector";
import { ExtensionMissing, rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { EnTitle } from "@/components/page-title";

type View = { kind: "checking" } | { kind: "ready"; account: Account; pc: PcState } | { kind: "blocked"; message: string };

const PC_MISSING = "이 PC에 SyncUp을 연결하면 내 대화와 팀 기록을 볼 수 있어요.";
// PC가 연결되지 않아도 여는 화면: 대시보드(팀 카드 + 연결 띠)와 대화 수집(연결 안내). 나머지는 틀 안에 'PC 연결 필요'를 보인다
const pcOptional = (pathname: string) => pathname === "/dashboard" || pathname === "/collect";
// 팀 만들기·초대 참여 화면은 사이드바 없이 헤더만
const setupFlow = (pathname: string) => pathname.startsWith("/team/new") || pathname.startsWith("/join");

// The native host still enforces local access and the API enforces membership. This gate prevents the UI from
// showing a different PC account's cached cards after a browser login or expired web session.
export function AppAccessGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const publicFlow = pathname === "/connect" || pathname === "/auth/callback" || pathname.startsWith("/join/");
  // The dedicated loopback launcher authenticates /api/local with its one-use HttpOnly session.
  // Production configuration rejects this flag; it never bypasses hosted account checks.
  if (USE_MOCK || process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") return <LocalShell setup={setupFlow(pathname)}>{children}</LocalShell>;
  if (publicFlow) return <><PublicHeader /><main className="flex-1">{children}</main></>;
  return <CheckedApp pathname={pathname}>{children}</CheckedApp>;
}

/** 목업·로컬 브리지: 웹 로그인 없이 수집기 상태만으로 PC 연결을 보인다 */
function LocalShell({ setup, children }: { setup: boolean; children: React.ReactNode }) {
  const { available, checked } = useCollectorStatus();
  const pc: PcState = !checked ? { kind: "checking" } : available ? { kind: "ok" } : { kind: "off", message: PC_MISSING };
  return <DashboardShell account={null} pc={pc} recheck={() => void refreshCollector()} setup={setup}>{children}</DashboardShell>;
}

// 화면을 옮겨도 틀(헤더·사이드바)을 다시 그리지 않도록 주소마다 새로 만들지 않고, 주소가 바뀔 때 확인만 다시 한다
function CheckedApp({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const recheck = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetch("/api/onboarding", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          if (!controller.signal.aborted) { setView({ kind: "checking" }); location.replace(loginUrl(pathname)); }
          return;
        }
        if (!response.ok) throw new Error("로그인 상태를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
        const account = readAccount(await response.json());
        let pc: PcState;
        try {
          const status = await rpc<ExtStatus>("collection.status");
          const problem = connectionProblem(account, status);
          pc = problem ? { kind: "off", message: problem } : { kind: "ok" };
        } catch (error) {
          pc = { kind: "off", message: error instanceof ExtensionMissing ? PC_MISSING : (error as Error).message };
        }
        if (!controller.signal.aborted) setView({ kind: "ready", account, pc });
      } catch (error) {
        if (!controller.signal.aborted) setView({ kind: "blocked", message: (error as Error).message });
      } finally { running = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 60000);
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [pathname, attempt]);

  if (view.kind === "ready") {
    const open = view.pc.kind === "ok" || pcOptional(pathname);
    return <DashboardShell account={view.account} pc={view.pc} recheck={recheck} setup={setupFlow(pathname)}>
      {open ? children : <PcRequiredPanel name={view.account.name} message={view.pc.kind === "off" ? view.pc.message : ""} />}
    </DashboardShell>;
  }
  return <><PublicHeader /><main className="mx-auto w-full max-w-xl px-gutter py-14">
    <section className={cn(card, "space-y-5 p-7")}>
      {view.kind === "checking" ? <p role="status">로그인과 PC 연결을 확인하고 있어요…</p> : <>
        <EnTitle>Check your connection.</EnTitle><h1 className="text-xl font-bold">연결을 확인해 주세요</h1>
        <p role="alert" className="text-sm leading-relaxed text-muted-foreground">{view.message}</p>
        <div className="flex flex-wrap gap-2">
          <button className={buttonOutline} onClick={() => { setView({ kind: "checking" }); recheck(); }}>다시 확인</button>
          <LogoutButton />
        </div>
      </>}
    </section>
  </main></>;
}

function PublicHeader() {
  return <header className="border-b"><div className="mx-auto flex h-16 max-w-wide items-center justify-between px-gutter"><Brand /><Link href="/start" className="text-sm hover:underline">내 계정·팀</Link></div></header>;
}
