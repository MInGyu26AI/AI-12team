import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sentences } from "@/components/ui/sentences";

// 앱 화면 제목. display 가 있으면 시안 "로즈 & 올리브 수채화"의 영어 큰 제목(Inter Tight 800)을 h1 로 두고
// 원래 한국어 제목은 그 아래 굵은 줄로, 설명은 그 아래에 그대로 둔다. actions 는 오른쪽 버튼 자리
export function PageTitle({ title, display, children, actions, className }: {
  title: ReactNode;
  display?: ReactNode; // 영어 큰 제목
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0 space-y-2">
        {display ? (
          <>
            <h1 className="title-display text-[clamp(38px,6vw,64px)] text-ink">{display}</h1>
            <p className="text-lg leading-[1.5] font-bold break-keep text-ink sm:text-xl">{title}</p>
          </>
        ) : (
          <h1 className="text-2xl leading-[1.5] font-bold break-keep sm:text-[28px]">{title}</h1>
        )}
        {children && <p className="text-[15px] leading-[1.5] text-ink-body break-keep"><Sentences>{children}</Sentences></p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** 영어 큰 제목 한 줄 (Inter Tight 800). 화면마다 한국어 h1 바로 위에 둔다. 읽어 주는 화면에는 한국어 제목만 들리게 aria-hidden */
export function EnTitle({ children }: { children: ReactNode }) {
  return (
    <p aria-hidden className="title-display mb-3 text-[clamp(34px,5vw,56px)] text-ink">
      {children}
    </p>
  );
}
