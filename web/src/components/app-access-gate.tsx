"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ExtStatus } from "@shared/bridge";
import { Brand } from "./brand";
import { AppHeader } from "./app-header";
import { LogoutButton } from "./logout-button";
import { buttonOutline, buttonPrimary, card } from "./ui/surface";
import { USE_MOCK } from "@/lib/api";
import { connectionProblem, loginUrl, readAccount, type Account } from "@/lib/auth-navigation";
import { WebAccountContext } from "@/lib/account-context";
import { ExtensionMissing, rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";

type View = { kind: "checking" } | { kind: "ready"; account: Account } | { kind: "blocked"; message: string; account?: Account };

// The native host still enforces local access and the API enforces membership. This gate prevents the UI from
// showing a different PC account's cached cards after a browser login or expired web session.
export function AppAccessGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const publicFlow = pathname === "/connect" || pathname === "/auth/callback" || pathname.startsWith("/join/");
  // The dedicated loopback launcher authenticates /api/local with its one-use HttpOnly session.
  // Production configuration rejects this flag; it never bypasses hosted account checks.
  if (USE_MOCK || process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") return <><AppHeader /><main className="flex-1">{children}</main></>;
  if (publicFlow) return <><PublicHeader /><main className="flex-1">{children}</main></>;
  return <CheckedApp key={pathname} pathname={pathname}>{children}</CheckedApp>;
}

function CheckedApp({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      let account: Account | undefined;
      try {
        const response = await fetch("/api/onboarding", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          if (!controller.signal.aborted) { setView({ kind: "checking" }); location.replace(loginUrl(pathname)); }
          return;
        }
        if (!response.ok) throw new Error("로그인 상태를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
        account = readAccount(await response.json());
        const status = await rpc<ExtStatus>("collection.status");
        const problem = connectionProblem(account, status);
        if (problem) throw new Error(problem);
        if (!controller.signal.aborted) setView({ kind: "ready", account });
      } catch (error) {
        if (!controller.signal.aborted) setView({ kind: "blocked", account,
          message: error instanceof ExtensionMissing ? "이 PC에 SyncUp을 연결하면 내 대화와 팀 기록을 볼 수 있어요." : (error as Error).message });
      } finally { running = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 60000);
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [pathname, attempt]);

  if (view.kind === "ready") return <WebAccountContext.Provider value={view.account}>
    <AppHeader /><main className="flex-1">{children}</main>
  </WebAccountContext.Provider>;
  return <><PublicHeader /><main className="mx-auto w-full max-w-xl px-gutter py-14">
    <section className={cn(card, "space-y-5 p-7")}>
      {view.kind === "checking" ? <p role="status">로그인과 PC 연결을 확인하고 있어요…</p> : <>
        <h1 className="text-xl font-medium">{view.account ? `${view.account.name}님, PC 연결을 확인해 주세요` : "연결을 확인해 주세요"}</h1>
        <p role="alert" className="text-sm leading-relaxed text-muted-foreground">{view.message}</p>
        <div className="flex flex-wrap gap-2">
          {view.account && <><Link href="/install" className={buttonPrimary}>내 PC 연결하기</Link><Link href="/connect" className={buttonOutline}>연결 계정 바꾸기</Link><Link href="/start" className={buttonOutline}>내 팀 확인</Link></>}
          <button className={buttonOutline} onClick={() => { setView({ kind: "checking" }); setAttempt(n => n + 1); }}>다시 확인</button>
          <LogoutButton />
        </div>
      </>}
    </section>
  </main></>;
}

function PublicHeader() {
  return <header className="border-b"><div className="mx-auto flex h-16 max-w-wide items-center justify-between px-gutter"><Brand /><Link href="/start" className="text-sm hover:underline">내 계정·팀</Link></div></header>;
}
