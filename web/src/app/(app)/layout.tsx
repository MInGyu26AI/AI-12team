import { Suspense } from "react";
import { AppAccessGate } from "@/components/app-access-gate";

// 앱 화면 (대화 수집 · 승인함 · 팀 결정 기록 · 팀 만들기): 크림 바탕 (새 피그마 디자인)
// AppHeader 는 주소(usePathname)를 읽으므로 Suspense 안에 둔다 (Cache Components: 동적 경로 사전 렌더링)
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <Suspense fallback={<div className="h-[104px] border-b bg-canvas md:h-16" />}>
        <AppAccessGate>{children}</AppAccessGate>
      </Suspense>
    </div>
  );
}
