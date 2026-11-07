"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, Inbox, LayoutList } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/review", label: "개인 검토함", icon: Inbox },
  { href: "/board", label: "팀 보드", icon: LayoutList },
  { href: "/install", label: "확장 설치", icon: Download },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-content items-center justify-between gap-3 px-gutter">
        <Link href="/board" className="text-lg font-bold tracking-tight">
          싱크업
        </Link>
        <nav className="flex gap-0.5 sm:gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5",
                pathname.startsWith(href) && "bg-muted font-medium text-foreground",
              )}
            >
              <Icon className="hidden size-4 sm:block" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
