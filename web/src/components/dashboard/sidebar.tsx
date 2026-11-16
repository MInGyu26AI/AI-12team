"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, CircleHelp, Inbox, MessagesSquare, Plus, Users } from "lucide-react";
import { USE_MOCK } from "@/lib/api";
import { useCollectorStatus } from "@/lib/local-collector";
import { useTeam } from "@/lib/team";
import { cn } from "@/lib/utils";
import { useDashboard } from "./context";
import { TeamSwatch } from "./team-swatch";

const row = "flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm whitespace-nowrap text-ink-body hover:bg-blush/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-2";
const active = "bg-blush font-medium text-ink hover:bg-blush";

/**
 * 왼쪽 사이드바 (손그림): 대시보드 ▸ 팀(팀 목록 · 새 팀 만들기) / 대화 수집 / 승인함, 맨 아래 이 PC 상태 · 이용 방법.
 * 좁은 화면(md 미만)에서는 헤더 아래 가로 줄로 바뀐다
 */
export function Sidebar() {
  const pathname = usePathname();
  const { account, pc, openCreateTeam, openFlow } = useDashboard();
  const team = useTeam();
  const { status } = useCollectorStatus();
  const pending = status?.counts?.reviewPending;
  // 실제 모드: 계정의 팀 목록, 이 PC가 연결된 팀만 팀 보드로 들어간다. 목업: 이 브라우저의 예시 팀 하나
  const teams = account
    ? account.teams.map((t) => ({ id: t.id, name: t.name, linked: t.id === status?.teamId }))
    : USE_MOCK ? [{ id: team.code || "demo", name: team.name, linked: true }] : [];
  const on = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

  const pcLabel = pc.kind === "ok" ? "이 PC 연결됨" : pc.kind === "off" ? "이 PC 연결 안 됨" : "연결 확인 중";
  const pcDot = pc.kind === "ok" ? "bg-ok" : "border border-faint";

  return (
    <aside aria-label="대시보드 메뉴" className="border-b border-card-border md:sticky md:top-16 md:flex md:h-[calc(100dvh-4rem)] md:w-60 md:shrink-0 md:flex-col md:justify-between md:overflow-y-auto md:border-r md:border-b-0 md:px-3 md:py-4">
      {/* 넓은 화면: 세로 메뉴 */}
      <nav className="hidden flex-col gap-0.5 md:flex">
        <Link href="/dashboard" className={cn(row, "font-medium text-ink")}>
          <ChevronDown aria-hidden className="!text-ink" />대시보드
        </Link>
        <Link href="/dashboard" aria-current={pathname === "/dashboard" ? "page" : undefined} className={cn(row, "pl-9", pathname === "/dashboard" && active)}>
          <Users aria-hidden />팀
        </Link>
        {teams.map((t, i) => t.linked ? (
          <Link key={t.id} href="/board" aria-current={on("/board") ? "page" : undefined} className={cn(row, "h-8 pl-[60px] text-[13px]", on("/board") && active)}>
            <TeamSwatch index={i} className="size-4" />
            <span className="min-w-0 truncate">{t.name}</span>
          </Link>
        ) : (
          <span key={t.id} title="이 PC는 다른 팀에 연결돼 있어요. SyncUp 앱에서 팀을 바꾸면 기록이 보여요" className={cn(row, "h-8 cursor-default pl-[60px] text-[13px] text-ink-3 hover:bg-transparent")}>
            <TeamSwatch index={i} className="size-4 opacity-60" />
            <span className="min-w-0 truncate">{t.name}</span>
          </span>
        ))}
        {USE_MOCK ? (
          <Link href="/team/new" className={cn(row, "h-8 pl-[60px] text-[13px] text-ink-2")}><Plus aria-hidden />새 팀 만들기</Link>
        ) : (
          <button type="button" onClick={openCreateTeam} className={cn(row, "h-8 pl-[60px] text-[13px] text-ink-2")}><Plus aria-hidden />새 팀 만들기</button>
        )}
        <Link href="/collect" aria-current={on("/collect") ? "page" : undefined} className={cn(row, "mt-0.5 pl-9", on("/collect") && active)}>
          <MessagesSquare aria-hidden />대화 수집
        </Link>
        <Link href="/review" aria-current={on("/review") ? "page" : undefined} className={cn(row, "pl-9", on("/review") && active)}>
          <Inbox aria-hidden /><span className="flex-1">승인함</span>
          {!!pending && <span className="font-mono text-xs text-ink-3 tabular-nums">{pending}</span>}
        </Link>
      </nav>
      <div className="hidden flex-col gap-0.5 md:flex">
        <Link href="/collect?tab=connection" className={cn(row, "text-[13px] text-ink-2")}>
          <span aria-hidden className="flex w-4 justify-center"><span className={cn("size-2 rounded-full", pcDot)} /></span>{pcLabel}
        </Link>
        <button type="button" onClick={openFlow} className={row}><CircleHelp aria-hidden />이용 방법</button>
      </div>

      {/* 좁은 화면: 가로 줄 */}
      <nav className="flex gap-1 overflow-x-auto px-gutter py-2 md:hidden">
        <Link href="/dashboard" className={cn(row, "w-auto", pathname === "/dashboard" && active)}>팀</Link>
        <Link href="/board" className={cn(row, "w-auto", on("/board") && active)}>팀 결정 기록</Link>
        <Link href="/collect" className={cn(row, "w-auto", on("/collect") && active)}>대화 수집</Link>
        <Link href="/review" className={cn(row, "w-auto", on("/review") && active)}>승인함{!!pending && ` ${pending}`}</Link>
        <button type="button" onClick={openFlow} className={cn(row, "w-auto")}>이용 방법</button>
      </nav>
    </aside>
  );
}
