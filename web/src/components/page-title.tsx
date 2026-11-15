import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// 앱 화면 제목 (피그마: 제목 28px 보통 굵기 · 설명 15px 2단계 글자색 · 사이 6px). actions 는 오른쪽 버튼 자리
export function PageTitle({ title, children, actions, className }: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-4", className)}>
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl leading-[1.5] font-medium break-keep sm:text-[28px]">{title}</h1>
        {children && <p className="text-[15px] leading-[1.5] text-muted-foreground break-keep">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
