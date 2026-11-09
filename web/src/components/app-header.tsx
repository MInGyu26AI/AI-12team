"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AvatarStack } from "@/components/avatar";
import { Brand } from "@/components/brand";
import { useTeam } from "@/lib/team";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/collect", label: "대화 수집" },
  { href: "/review", label: "승인함" },
  { href: "/board", label: "팀 결정 기록" },
];

export function AppHeader() {
  const pathname = usePathname();
  const team = useTeam();
  const setup = pathname.startsWith("/team/new") || pathname.startsWith("/join");

  return (
    <header className="sticky top-0 z-30 border-b bg-background">
      <div className="relative mx-auto flex max-w-wide flex-wrap items-center gap-3 px-gutter py-3 md:h-16 md:flex-nowrap md:py-0">
        <Brand href="/" />
        {!setup && (
          <span className="hidden rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground lg:inline">
            {team.name}
          </span>
        )}
        <nav className="order-last flex w-full justify-center gap-1 md:order-none md:ml-auto md:w-auto md:gap-6 lg:absolute lg:left-1/2 lg:-translate-x-1/2">
          {NAV.map(({ href, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground md:text-[15px]",
                  active && "font-semibold text-brand",
                  setup && "pointer-events-none opacity-50",
                )}
              >
                {label}
                {active && <span className="absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-brand md:-bottom-[17px]" />}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <AvatarStack names={setup ? [team.me] : team.members.map((m) => m.name)} />
        </div>
      </div>
    </header>
  );
}
