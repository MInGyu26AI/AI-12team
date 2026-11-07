"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, LayoutList } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/review", label: "개인 검토함", icon: Inbox },
  { href: "/board", label: "팀 보드", icon: LayoutList },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-page items-center justify-between gap-3 px-page">
        <Link href="/board" className="text-lg font-bold tracking-tight">
          싱크업
        </Link>
        <nav className="flex gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                pathname.startsWith(href) && "bg-muted font-medium text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
