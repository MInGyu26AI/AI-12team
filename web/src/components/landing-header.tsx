"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { buttonVariants } from "@/components/ui/button";
import { consentUrl, needsConsent } from "@/lib/auth-navigation";
import { START } from "@/lib/start-link";
import { useSignedIn } from "@/lib/use-signed-in";
import { cn } from "@/lib/utils";

// 헤더 탭은 서비스 소개 하나(첫 화면에는 없음). '이용 방법'·'브라우저 확장' 탭은 서비스 소개와 겹쳐 뺐다
// (이용 방법은 대시보드 사이드바, 확장 설치는 대화 수집 · PC 연결에서 본다. /install 화면은 다른 화면이 링크하므로 그대로 둔다)
const NAV = [{ href: "/about", label: "서비스 소개" }];

export function LandingHeader() {
  const pathname = usePathname();
  const account = useSignedIn();
  // 약관 동의 전 계정은 대시보드 버튼이 동의 화면을 거쳐 간다
  const consentPending = !!account && needsConsent(account);
  // 로그인한 사람도 첫 화면(/)을 그대로 본다. 자동으로 대시보드로 보내지 않고, 오른쪽 위 "대시보드" 버튼을 눌러야 간다
  // 앱 헤더(app-header.tsx)와 같은 새 피그마 헤더 모양: 크림 바탕 · 아래 테두리 · 탭 글자 15px 보통 굵기 + 현재 탭 24×3px 남색 막대
  return (
    <header className="sticky top-0 z-30 border-b bg-canvas">
      <div className="mx-auto flex max-w-wide flex-wrap items-center gap-x-4 gap-y-2 px-gutter py-3 md:h-16 md:flex-nowrap md:px-8 md:py-0 lg:grid lg:grid-cols-[1fr_auto_1fr]">
        <Brand />
        {/* 첫 화면(/)은 그 자체가 서비스 소개라 탭을 두지 않는다. 가운데 칸은 비워 둬 오른쪽 버튼 자리가 그대로 오른쪽에 남게 한다 */}
        {pathname === "/" ? <span aria-hidden className="hidden lg:block" /> : (
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
        )}
        <div className="ml-auto flex items-center gap-2 lg:ml-0 lg:justify-self-end">
          {account ? (
            // 로그인 상태: 버튼 대신 프로필 동그라미 (대시보드 · 서비스 소개 · 로그아웃은 메뉴 안)
            <>
              <Link href={consentPending ? consentUrl("/dashboard") : "/dashboard"} className={cn(buttonVariants({ variant: "outline" }), "h-10 rounded-md border-input px-3 sm:px-[18px]")}>
                대시보드
              </Link>
              <ProfileMenu name={account.name} detail="GitHub 로그인" myPage="/me" canLogout />
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
