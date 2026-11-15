import { Suspense } from "react";
import { LandingHeader } from "@/components/landing-header";

// LandingHeader 는 주소(usePathname)로 현재 메뉴를 표시하므로 Suspense 안에 둔다
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<div className="h-[92px] border-b md:h-16" />}>
        <LandingHeader />
      </Suspense>
      <div className="flex-1">{children}</div>
      {/* 피그마 Footer (149:147): 왼쪽 서비스 이름 · 오른쪽 상표 안내 */}
      <footer className="border-t">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-gutter py-8 sm:px-10 lg:px-20">
          <p className="text-[13px] font-medium text-muted-foreground">SyncUp · Shared Memory for Students</p>
          <p className="text-xs text-text-tertiary">ChatGPT는 OpenAI의 상표이며, SyncUp은 OpenAI와 제휴 관계가 없습니다</p>
        </div>
      </footer>
    </>
  );
}
