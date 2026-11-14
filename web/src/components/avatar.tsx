"use client";

import type { TeamMember } from "@shared/mock";
import { useTeam, memberOf } from "@/lib/team";
import { cn } from "@/lib/utils";

const FALLBACK = "#eadfcf"; // 새 디자인 아바타 색 중 중립 베이지 (유)
const NAVY = "#18173a";

// 팀원 색 위의 글자색. 새 디자인의 연한 색은 남색 글자, 예전에 저장된 진한 색(브라우저에 남은 목업 팀)은 흰 글자로 읽히게 한다.
function textOn(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg);
  if (!m) return NAVY;
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.2 ? NAVY : "#ffffff"; // 0.2 = 남색 글자와 흰 글자의 대비가 같아지는 밝기
}

export function Avatar({ name, size = "md", className }: { name: string | null | undefined; size?: "sm" | "md"; className?: string }) {
  const team = useTeam();
  const m: TeamMember | null = memberOf(team, name);
  const label = m?.initial ?? (name ? name.slice(-2, -1) || name[0] : "?");
  const bg = m?.color ?? FALLBACK;
  return (
    <span
      title={name ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium",
        // 피그마 아바타: 32px 안쪽에 흰 테두리 2px (테두리가 바깥으로 나가지 않는다)
        size === "sm" ? "size-5 text-[10px] ring-2 ring-background" : "size-8 border-2 border-background text-[13px]",
        className,
      )}
      style={{ background: bg, color: textOn(bg) }}
    >
      {label}
    </span>
  );
}

export function AvatarStack({ names }: { names: string[] }) {
  return (
    <span className="flex -space-x-2">
      {names.map((n) => (
        <Avatar key={n} name={n} />
      ))}
    </span>
  );
}
