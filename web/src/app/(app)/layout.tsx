import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";

// 앱 화면 (대화 수집 · 승인함 · 팀 결정 기록 · 팀 만들기): 연회색 바탕 (피그마 2~6번)
// AppHeader 는 주소(usePathname)를 읽으므로 Suspense 안에 둔다 (Cache Components: 동적 경로 사전 렌더링)
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <Suspense fallback={<div className="h-[104px] border-b bg-background md:h-16" />}>
        <AppHeader />
      </Suspense>
      <main className="flex-1">{children}</main>
    </div>
  );
}
