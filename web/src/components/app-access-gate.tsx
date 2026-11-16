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
import { EnTitle } from "@/components/page-title";

type View = { kind: "checking" } | { kind: "ready"; account: Account } | { kind: "blocked"; message: string; account?: Account };
type CheckResult =
  | { kind: "login" }
  | { kind: "ready"; account: Account }
  | { kind: "failed"; transient: boolean; message: string; account?: Account };

// The native host still enforces local access and the API enforces membership. This gate prevents the UI from
// showing a different PC account's cached cards after a browser login or expired web session.
export function AppAccessGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const publicFlow = pathname === "/connect" || pathname === "/auth/callback" || pathname.startsWith("/join/");
  // The dedicated loopback launcher authenticates /api/local with its one-use HttpOnly session.
  // Production configuration rejects this flag; it never bypasses hosted account checks.
  if (USE_MOCK || process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") return <><AppHeader /><main className="flex-1">{children}</main></>;
  if (publicFlow) return <><PublicHeader /><main className="flex-1">{children}</main></>;
  return <CheckedApp pathname={pathname}>{children}</CheckedApp>;
}

// 요청 한도(429)·서버 오류(5xx)처럼 잠시 뒤 다시 하면 풀리는 응답. 401·403 같은 거절은 아니다
export const isTransientStatus = (status: number) => status === 429 || status >= 500;
export const checkFailureMessage = (status: number) => status === 429
  ? "요청이 잠시 몰렸어요. 잠깐 기다렸다가 '다시 확인'을 눌러 주세요."
  : "로그인 상태를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.";

/** 로그인(/api/onboarding)과 PC 연결(collection.status)을 한 번 확인한다. 던지지 않고 결과로 돌려준다 (취소는 부른 쪽이 signal 로 거른다) */
export async function checkAccess(signal: AbortSignal): Promise<CheckResult> {
  let response: Response;
  try { response = await fetch("/api/onboarding", { cache: "no-store", signal }); }
  catch { return { kind: "failed", transient: true, message: checkFailureMessage(0) }; } // 네트워크 끊김
  if (response.status === 401) return { kind: "login" };
  if (!response.ok) return { kind: "failed", transient: isTransientStatus(response.status), message: checkFailureMessage(response.status) };
  let account: Account | undefined;
  try {
    account = readAccount(await response.json());
    const problem = connectionProblem(account, await rpc<ExtStatus>("collection.status"));
    return problem ? { kind: "failed", transient: false, message: problem, account } : { kind: "ready", account };
  } catch (error) {
    return { kind: "failed", transient: false, account,
      message: error instanceof ExtensionMissing ? "이 PC에 SyncUp을 연결하면 내 대화와 팀 기록을 볼 수 있어요." : (error as Error).message };
  }
}

/** 확인 결과에 따른 다음 화면. 이미 열린(ready) 화면은 일시 실패 한 번으로 막지 않고, 다음 확인 때 다시 본다 */
export function nextView(previous: View, result: CheckResult): View {
  if (result.kind === "login") return { kind: "checking" };
  if (result.kind === "ready") return result;
  if (result.transient && previous.kind === "ready") return previous;
  return { kind: "blocked", message: result.message, account: result.account };
}

// 쪽을 옮겨도(key 없음) 이미 열린 ready 화면은 버리지 않고, 새 쪽의 확인이 실패(일시 실패 제외)할 때만 막는다
function CheckedApp({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const result = await checkAccess(controller.signal);
        if (controller.signal.aborted) return;
        if (result.kind === "login") location.replace(loginUrl(pathname));
        setView(previous => nextView(previous, result));
      } finally { running = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 60000);
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [pathname, attempt]);

  if (view.kind === "ready") return <WebAccountContext.Provider key={pathname} value={view.account}>
    <AppHeader /><main className="flex-1">{children}</main>
  </WebAccountContext.Provider>;
  return <><PublicHeader /><main className="mx-auto w-full max-w-xl px-gutter py-14">
    <section className={cn(card, "space-y-5 p-7")}>
      {view.kind === "checking" ? <p role="status">로그인과 PC 연결을 확인하고 있어요…</p> : <>
        <EnTitle>Check your connection.</EnTitle><h1 className="text-xl font-bold">{view.account ? `${view.account.name}님, PC 연결을 확인해 주세요` : "연결을 확인해 주세요"}</h1>
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
