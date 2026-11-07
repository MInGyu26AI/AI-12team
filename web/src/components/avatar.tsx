"use client";

import type { TeamMember } from "@shared/mock";
import { useTeam, memberOf } from "@/lib/team";
import { cn } from "@/lib/utils";

const FALLBACK = "#9CA3AF";

export function Avatar({ name, size = "md", className }: { name: string | null | undefined; size?: "sm" | "md"; className?: string }) {
  const [team] = useTeam();
  const m: TeamMember | null = memberOf(team, name);
  const label = m?.initial ?? (name ? name.slice(-2, -1) || name[0] : "?");
  return (
    <span
      title={name ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-background",
        size === "sm" ? "size-5 text-[10px]" : "size-8 text-sm",
        className,
      )}
      style={{ background: m?.color ?? FALLBACK }}
    >
      {label}
    </span>
  );
}

export function AvatarStack({ names }: { names: string[] }) {
  return (
    <span className="flex -space-x-1.5">
      {names.map((n) => (
        <Avatar key={n} name={n} />
      ))}
    </span>
  );
}
