import Link from "next/link";

// 피그마 로고: "Sync up" + "Shared Memory for Students"
export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex flex-col leading-none">
      <span className="text-xl font-bold tracking-tight text-brand">Sync up</span>
      <span className="mt-1 hidden text-[11px] text-muted-foreground sm:block">Shared Memory for Students</span>
    </Link>
  );
}
