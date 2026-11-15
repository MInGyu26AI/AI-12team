"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AvatarStack } from "@/components/avatar";
import { Brand } from "@/components/brand";
import { LogoutButton } from "@/components/logout-button";
import { useWebAccount } from "@/lib/account-context";
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
  const account = useWebAccount();
  const setup = pathname.startsWith("/team/new") || pathname.startsWith("/join");

  // 새 피그마 헤더 (노드 182:3): 크림 바탕 · 아래 테두리 · 가로 32px 세로 12px 여백. 왼쪽 로고+팀 칩, 가운데 탭, 오른쪽 아바타
  return (
    <header className="sticky top-0 z-30 border-b bg-canvas">
      <div className="mx-auto flex max-w-wide flex-wrap items-center gap-x-3.5 gap-y-2 px-gutter py-3 md:h-16 md:flex-nowrap md:px-8 md:py-0 lg:grid lg:grid-cols-[1fr_auto_1fr]">
        <div className="flex min-w-0 items-center gap-3.5">
          <Brand href="/" />
          {!setup && (
            <span className="hidden max-w-48 truncate rounded-full border border-muted-foreground bg-brand-soft px-2.5 py-[3px] text-xs leading-[1.5] font-medium text-muted-foreground lg:block">
              {team.name}
            </span>
          )}
        </div>
        <nav className="order-last flex w-full justify-center gap-6 md:order-none md:ml-auto md:w-auto md:gap-7 lg:ml-0">
          {NAV.map(({ href, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-1 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground md:text-[15px]",
                  active && "text-brand",
                  setup && "pointer-events-none opacity-50",
                )}
              >
                {label}
                {/* 현재 탭 밑줄 막대 24×3px. 선택 안 된 탭도 자리를 비워 글자 높이가 같다 */}
                <span aria-hidden className={cn("h-[3px] w-6 rounded-[2px]", active && "bg-brand")} />
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 lg:ml-0 lg:justify-self-end">
          {account ? <><Link href="/start" className="max-w-28 truncate text-sm hover:underline">{account.name}</Link><LogoutButton className="px-2 py-1 text-xs" /></> :
            <AvatarStack names={setup ? [team.me] : team.members.map((m) => m.name)} />}
        </div>
      </div>
    </header>
  );
}
