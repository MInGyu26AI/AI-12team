"use client";

import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import { loginDestination, readAccount, type Account } from "@/lib/auth-navigation";
import { card, chip } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { EnTitle } from "@/components/page-title";

// GitHub account login works before installing the extension; PC connection is a separate step after signup.

// 개인정보 처리방침은 팀 레포 문서로 연결한다 (웹에 따로 만든 약관 화면이 없다)
const PRIVACY_URL = "https://github.com/MInGyu26AI/AI-12team/blob/main/docs/privacy.md";

const provider = "flex w-full items-center justify-center gap-2.5 rounded-[10px] py-[13px] text-[15px] leading-[1.5] font-medium";
const subscribe = () => () => {};
const currentQuery = () => location.search;
const serverQuery = () => "";

export default function LoginPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = new URLSearchParams(useSyncExternalStore(subscribe, currentQuery, serverQuery));
  const next = loginDestination(query.get("next"));
  const displayedError = error || (query.has("error") ? "로그인이 취소됐거나 시간이 지났어요. 다시 시도해 주세요." : "");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal }).then(async response => {
      // 이미 로그인돼 있으면 묻지 않고 가려던 화면(기본 대시보드)으로 바로 보낸다
      if (response.ok) { setAccount(readAccount(await response.json())); location.replace(next); }
      else if (response.status !== 401) throw new Error("로그인 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [next]);
  const login = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/onboarding/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ next }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "로그인을 시작하지 못했어요.");
      const target = new URL(data.url);
      if (target.protocol !== "https:" || !target.hostname.endsWith(".supabase.co") || target.pathname !== "/auth/v1/authorize") throw new Error("로그인 연결 정보를 확인하지 못했어요.");
      location.assign(target.href);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="flex justify-center px-gutter pt-12 pb-24 sm:pt-[72px]">
      <section className={cn(card, "w-full max-w-[460px] space-y-5 rounded-2xl px-6 pt-10 pb-9 sm:px-10")} aria-labelledby="login-title">
        <div className="space-y-1.5">
          <EnTitle>Welcome back.</EnTitle><h1 id="login-title" className="text-2xl leading-[1.5] font-bold">
            로그인
          </h1>
          <p className="text-sm leading-[1.5] text-muted-foreground break-keep">팀 프로젝트 대화에서 결정만 모아, 내가 승인한 것만 나눠요.</p>
        </div>

        {displayedError && <p role="alert" className="rounded-lg bg-sensitive-soft p-3 text-sm text-sensitive">{displayedError}</p>}
        {account ? <p role="status" className="text-sm">{account.name}님으로 로그인되어 있어요. 이어서 이동하고 있어요…</p> : <button type="button" disabled={busy || checking} onClick={login} className={cn(provider, "bg-brand text-white hover:bg-brand-hover disabled:cursor-wait disabled:opacity-60")}>
          <Image src="/brand/github.svg" alt="" width={18} height={18} unoptimized className="brightness-0 invert" />
          {checking ? "로그인 상태 확인 중…" : busy ? "GitHub로 이동 중…" : "GitHub로 계속하기"}
        </button>}
        <SoonButton className="border border-card-border bg-white text-foreground">
          <Image src="/brand/google-g.svg" alt="" width={18} height={18} unoptimized />
          Google로 계속하기
        </SoonButton>
        <SoonButton className="bg-[#fee500] text-black/85">
          <Image src="/brand/kakao-symbol.svg" alt="" width={18} height={18} unoptimized />
          카카오로 계속하기
        </SoonButton>

        <p className="text-xs leading-[1.5] text-muted-foreground break-keep">
          처음 로그인하면 계정이 자동으로 만들어져요. 로그인 후 팀을 만들거나 초대받은 팀에 참여할 수 있어요.
        </p>
        <p className="text-xs leading-[1.5] text-muted-foreground">
          계속하면{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="font-medium text-foreground underline">
            개인정보 처리방침
          </a>
          에 동의하게 돼요.
        </p>
      </section>
    </div>
  );
}

// Unavailable providers are visibly disabled; they never simulate a successful login.
function SoonButton({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <button type="button" disabled className={cn(provider, "relative cursor-not-allowed opacity-60", className)}>
      {children}
      <span className={cn(chip, "absolute right-3 bg-black/6 py-0.5 text-[11px] text-current/70")}>준비 중</span>
    </button>
  );
}
