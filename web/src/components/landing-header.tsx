"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";
import { START } from "@/lib/start-link";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/about", label: "서비스 소개" },
  { href: "/guide", label: "이용 방법" },
  { href: "/install", label: "브라우저 확장" },
];

export function LandingHeader() {
  const pathname = usePathname();
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
        <div className="ml-auto flex gap-2 lg:ml-0 lg:justify-self-end">
          {/* 피그마 버튼: 주요 = 남색 바탕 흰 글자, 보조 = 흰 바탕 + #e2d6c3 테두리 + 남색 글자, 모서리 8, 글자 14px 보통 굵기 */}
          {START.href !== "/collect" && (
            <Link href="/collect" className={cn(buttonVariants({ variant: "outline" }), "h-10 rounded-md border-input px-3 sm:px-[18px]")}>
              대화 수집
            </Link>
          )}
          <Link href={START.href} className={cn(buttonVariants(), "h-10 rounded-md bg-brand px-3 hover:bg-brand-hover sm:px-[18px]")}>
            {START.short}
          </Link>
        </div>
      </div>
    </header>
  );
}
