"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { buttonVariants } from "@/components/ui/button";
import { USE_MOCK } from "@/lib/api";
import { readAccount, type Account } from "@/lib/auth-navigation";
import { START } from "@/lib/start-link";
import { cn } from "@/lib/utils";

/** 실제 모드에서 웹 로그인 여부. 목업은 웹 로그인이 없어 늘 null (버튼을 보인다) */
function useSignedIn(): Account | null {
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    if (USE_MOCK) return;
    const controller = new AbortController();
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal })
      .then(async (r) => { if (r.ok) setAccount(readAccount(await r.json())); })
      .catch(() => { /* 확인하지 못하면 로그인 전 화면 그대로 */ });
    return () => controller.abort();
  }, []);
  return account;
}

const NAV = [
  { href: "/about", label: "서비스 소개" },
  { href: "/guide", label: "이용 방법" },
  { href: "/install", label: "브라우저 확장" },
];

export function LandingHeader() {
  const pathname = usePathname();
  const account = useSignedIn();
  // 로그인한 사람의 기본 화면은 대시보드: 첫 화면(/)으로 오면 대시보드로 보낸다. 서비스 소개·이용 방법·브라우저 확장은 그대로 볼 수 있다
  useEffect(() => { if (account && pathname === "/") location.replace("/dashboard"); }, [account, pathname]);
  // 앱 헤더(app-header.tsx)와 같은 새 피그마 헤더 모양: 크림 바탕 · 아래 테두리 · 탭 글자 15px 보통 굵기 + 현재 탭 24×3px 남색 막대
  return (
    <header className="sticky top-0 z-30 border-b bg-canvas">
      <div className="mx-auto flex max-w-wide flex-wrap items-center gap-x-4 gap-y-2 px-gutter py-3 md:h-16 md:flex-nowrap md:px-8 md:py-0 lg:grid lg:grid-cols-[1fr_auto_1fr]">
        <Brand />
        <nav className="order-last flex w-full justify-center gap-6 md:order-none md:ml-auto md:w-auto md:gap-7 lg:ml-0">
          {NAV.map(({ href, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-1 text-sm font-medium whitespace-nowrap md:text-[15px]",
                  active ? "text-brand" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                <span aria-hidden className={cn("h-[3px] w-6 rounded-[2px]", active && "bg-brand")} />
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 lg:ml-0 lg:justify-self-end">
          {account ? (
            // 로그인 상태: 버튼 대신 프로필 동그라미 (대시보드 · 서비스 소개 · 로그아웃은 메뉴 안)
            <>
              <Link href="/dashboard" className={cn(buttonVariants({ variant: "outline" }), "h-10 rounded-md border-input px-3 sm:px-[18px]")}>
                대시보드
              </Link>
              <ProfileMenu name={account.name} detail="GitHub 로그인" myPage="/start" canLogout />
            </>
          ) : (
            // 로그인 전: 로그인 입구는 '가입 / 로그인' 하나 (예전 '로그인' 글자 링크는 같은 화면으로 가서 뺐다)
            <>
              {START.href !== "/collect" && (
                <Link href="/collect" className={cn(buttonVariants({ variant: "outline" }), "h-10 rounded-md border-input px-3 sm:px-[18px]")}>
                  대화 수집
                </Link>
              )}
              <Link href={START.href} className={cn(buttonVariants(), "h-10 rounded-md bg-brand px-3 hover:bg-brand-hover sm:px-[18px]")}>
                {START.short}
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
