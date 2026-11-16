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
import { connectionProblem, consentUrl, loginUrl, needsConsent, readAccount, type Account } from "@/lib/auth-navigation";
import { refreshCollector, useCollectorStatus } from "@/lib/local-collector";
import { ExtensionMissing, rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { EnTitle } from "@/components/page-title";

type View = { kind: "checking" } | { kind: "ready"; account: Account } | { kind: "blocked"; message: string; account?: Account };
type CheckResult =
  | { kind: "login" }
  | { kind: "ready"; account: Account }
  | { kind: "failed"; transient: boolean; message: string; account?: Account };

const PC_MISSING = "이 PC에 SyncUp을 연결하면 내 대화와 팀 기록을 볼 수 있어요.";
// PC가 연결되지 않아도 여는 화면: 대시보드(팀 카드 + 연결 띠), 대화 수집(연결 안내), 마이페이지(PC와 상관없는 계정 화면). 나머지는 틀 안에 'PC 연결 필요'를 보인다
const pcOptional = (pathname: string) => pathname === "/dashboard" || pathname === "/collect" || pathname === "/me";
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
      message: error instanceof ExtensionMissing ? PC_MISSING : (error as Error).message };
  }
}

/** 약관·처리방침에 아직(또는 바뀐 버전에) 동의하지 않은 계정이면 동의 화면 주소, 아니면 null.
 *  PC 연결이 막힌 결과(failed)에도 계정은 있으므로 PC 상태와 상관없이 동의가 먼저다. checkAccess 의 판정은 그대로 두고 화면 쪽에서 쓴다 */
export function consentRedirect(result: CheckResult, pathname: string): string | null {
  const account = result.kind === "login" ? undefined : result.account;
  return account && needsConsent(account) ? consentUrl(pathname) : null;
}

/** 확인 결과에 따른 다음 화면. 이미 열린(ready) 화면은 일시 실패 한 번으로 막지 않고, 다음 확인 때 다시 본다 */
export function nextView(previous: View, result: CheckResult): View {
  if (result.kind === "login") return { kind: "checking" };
  if (result.kind === "ready") return result;
  if (result.transient && previous.kind === "ready") return previous;
  return { kind: "blocked", message: result.message, account: result.account };
}

/** 목업·로컬 브리지: 웹 로그인 없이 수집기 상태만으로 PC 연결을 보인다 */
function LocalShell({ setup, children }: { setup: boolean; children: React.ReactNode }) {
  const { available, checked } = useCollectorStatus();
  const pc: PcState = !checked ? { kind: "checking" } : available ? { kind: "ok" } : { kind: "off", message: PC_MISSING };
  return <DashboardShell account={null} pc={pc} recheck={() => void refreshCollector()} setup={setup}>{children}</DashboardShell>;
}

// 쪽을 옮겨도(key 없음) 틀(헤더·사이드바)과 이미 열린 화면을 버리지 않고, 새 쪽의 확인이 실패(일시 실패 제외)할 때만 바꾼다.
// 로그인은 됐지만 PC 쪽이 막힌 경우(blocked + account)도 틀은 열고 PC 연결 안내를 보인다
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
        const result = await checkAccess(controller.signal);
        if (controller.signal.aborted) return;
        // 동의하지 않은 계정에는 앱 화면(과 개인 카드)을 열지 않고 동의 화면으로 보낸다
        const consent = consentRedirect(result, pathname);
        if (consent) { location.replace(consent); setView({ kind: "checking" }); return; }
        if (result.kind === "login") location.replace(loginUrl(pathname));
        // PC 미연결로 열려 있던 틀도 일시 실패 한 번으로 닫지 않는다
        setView(previous => result.kind === "failed" && result.transient && previous.kind === "blocked" && previous.account
          ? previous : nextView(previous, result));
      } finally { running = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 60000);
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [pathname, attempt]);

  const account = view.kind === "ready" ? view.account : view.kind === "blocked" ? view.account : undefined;
  if (account) {
    const pc: PcState = view.kind === "blocked" ? { kind: "off", message: view.message } : { kind: "ok" };
    const open = pc.kind === "ok" || pcOptional(pathname);
    return <DashboardShell account={account} pc={pc} recheck={recheck} setup={setupFlow(pathname)}>
      {open ? children : <PcRequiredPanel name={account.name} message={pc.kind === "off" ? pc.message : ""} />}
    </DashboardShell>;
  }
  return <><PublicHeader /><main className="mx-auto w-full max-w-xl px-gutter py-14">
    <section className={cn(card, "space-y-5 p-7")}>
      {view.kind === "checking" ? <p role="status">로그인과 PC 연결을 확인하고 있어요…</p> : view.kind === "blocked" && <>
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
