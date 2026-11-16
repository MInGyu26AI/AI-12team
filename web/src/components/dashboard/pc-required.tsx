"use client";

import Link from "next/link";
import { buttonOutline, buttonPrimary, card } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { useDashboard } from "./context";

/** 팀 화면 맨 위 진갈색 띠: 이 PC가 아직 연결되지 않았을 때만 (팀 보드 충돌 배너와 같은 모양) */
export function PcBanner() {
  const { pc, openInstall, recheck } = useDashboard();
  if (pc.kind !== "off") return null;
  return (
    <section aria-label="PC 연결" className="flex flex-wrap items-center gap-x-6 gap-y-4 bg-ink px-6 py-5 text-white">
      <div className="min-w-0 flex-[1_1_360px]">
        <p className="text-base font-medium">이 PC는 아직 연결되지 않았어요</p>
        <p className="mt-1 text-[13px] leading-relaxed break-keep text-flare">{pc.message}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={recheck} className="h-10 border border-white/30 px-4 text-sm text-white hover:bg-white/10">다시 확인</button>
        <button type="button" onClick={openInstall} className="h-10 bg-flare px-5 text-sm font-medium text-ink hover:bg-blush">PC 연결하기</button>
      </div>
    </section>
  );
}

/** 승인함·팀 보드처럼 이 PC의 수집기가 있어야 하는 화면: 틀(헤더·사이드바)은 두고 본문에 연결 안내 */
export function PcRequiredPanel({ name, message }: { name: string; message: string }) {
  const { openInstall, recheck } = useDashboard();
  return (
    <div className="mx-auto w-full max-w-xl px-gutter py-14">
      <section className={cn(card, "space-y-5 p-7")}>
        <h1 className="text-xl font-bold">{name}님, PC 연결을 확인해 주세요</h1>
        <p role="alert" className="text-sm leading-relaxed break-keep text-muted-foreground">{message}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonPrimary} onClick={openInstall}>PC 연결하기</button>
          <Link href="/connect" className={buttonOutline}>연결 계정 바꾸기</Link>
          <button type="button" className={buttonOutline} onClick={recheck}>다시 확인</button>
        </div>
      </section>
    </div>
  );
}
