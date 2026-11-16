"use client";

import { Brand } from "@/components/brand";
import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { USE_MOCK } from "@/lib/api";
import { useWebAccount } from "@/lib/account-context";
import { useTeam } from "@/lib/team";

// 로그인 후 헤더: 왼쪽 로고, 오른쪽 프로필 동그라미 하나 (손그림 대시보드 UI).
// 예전 가운데 탭(대화 수집 · 승인함 · 팀 결정 기록)은 왼쪽 사이드바(components/dashboard/sidebar.tsx)로 옮겼다
export function AppHeader() {
  const team = useTeam();
  const account = useWebAccount();
  const name = account?.name ?? (team.me || "나");
  return (
    <header className="sticky top-0 z-30 border-b border-card-border bg-canvas">
      <div className="flex h-16 items-center justify-between px-gutter md:px-8">
        <Brand href="/dashboard" />
        <ProfileMenu
          name={name}
          detail={account ? "GitHub 로그인" : USE_MOCK ? "예시 모드 · 이 브라우저에만 저장" : undefined}
          myPage="/me"
          canLogout={!!account}
        />
      </div>
    </header>
  );
}
