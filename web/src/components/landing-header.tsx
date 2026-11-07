"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/about", label: "서비스 소개" },
  { href: "/guide", label: "이용 방법" },
  { href: "/install", label: "브라우저 확장" },
];

export function LandingHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="relative mx-auto flex max-w-wide flex-wrap items-center gap-x-4 gap-y-2 px-gutter py-3 md:h-16 md:flex-nowrap md:py-0">
        <Brand />
        <nav className="order-last flex w-full justify-center gap-5 text-sm md:order-none md:ml-auto md:w-auto md:gap-8 md:text-[15px] lg:absolute lg:left-1/2 lg:-translate-x-1/2">
          {NAV.map(({ href, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={active ? "font-semibold text-brand" : "text-foreground/75 hover:text-foreground"}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex gap-2">
          <Link href="/collect" className={cn(buttonVariants({ variant: "outline" }), "h-9 px-3.5")}>
            로그인
          </Link>
          <Link href="/team/new" className={cn(buttonVariants(), "h-9 bg-brand px-3.5 hover:bg-brand-hover")}>
            팀 만들기
          </Link>
        </div>
      </div>
    </header>
  );
}
