import { Suspense } from "react";
import { LandingHeader } from "@/components/landing-header";
import { SiteFooter } from "@/components/site-footer";

// LandingHeader 는 주소(usePathname)로 현재 메뉴를 표시하므로 Suspense 안에 둔다
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<div className="h-[92px] border-b md:h-16" />}>
        <LandingHeader />
      </Suspense>
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </>
  );
}
