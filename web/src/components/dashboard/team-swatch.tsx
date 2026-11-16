import { cn } from "@/lib/utils";

// 팀마다 다른 수채 견본 (시안 "로즈 & 올리브 수채화"의 번짐 색). 대시보드에서 색을 쓰는 곳은 이 견본뿐이다
const WASHES = [
  ["var(--color-wash-rose)", "var(--color-wash-peach)"],
  ["var(--color-wash-olive)", "var(--color-wash-apricot)"],
  ["var(--color-wash-peach)", "var(--color-wash-olive-deep)"],
] as const;

export function TeamSwatch({ index, className }: { index: number; className?: string }) {
  const [a, b] = WASHES[index % WASHES.length];
  return (
    <span
      aria-hidden
      className={cn("shrink-0", className)}
      style={{
        background: `radial-gradient(circle at 28% 32%, ${a} 0%, transparent 62%), radial-gradient(circle at 74% 72%, ${b} 0%, transparent 58%), #f6efe9`,
        boxShadow: "inset 0 0 0 1px rgb(29 26 20 / 0.08)",
      }}
    />
  );
}
