"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import type { Team } from "@shared/mock";
import { AvatarStack } from "@/components/avatar";
import { card } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 피그마 Page 9 · 3 팀 참여 완료 (318:3): 팀 정보 요약 · 다음 단계 3개 · 확장 설치 / 팀 화면으로
const NEXT_STEPS = [
  { title: "브라우저 확장 설치", desc: "Chrome에 SyncUp 확장을 추가해요" },
  { title: "수집기 켜기", desc: "내 컴퓨터에서 대화를 모으는 프로그램을 켜요" },
  { title: "ChatGPT 프로젝트 고르기", desc: "팀 대화를 나눌 프로젝트만 골라요" },
];

const wide = "flex w-full items-center justify-center rounded-[10px] py-[13px] text-[15px] leading-[1.5] font-medium";

export function JoinDone({ team, me }: { team: Team; me: string }) {
  const leader = team.members.find((m) => m.leader)?.name;
  const names = team.members.map((m) => m.name);
  return (
    <div className="flex justify-center px-gutter pt-12 pb-24 sm:pt-[72px]">
      <section className={cn(card, "w-full max-w-[540px] space-y-5 rounded-2xl px-6 pt-10 pb-9 sm:px-10")} aria-labelledby="join-done-title">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand text-white">
          <Check className="size-6" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h1 id="join-done-title" className="text-2xl leading-[1.5] font-medium break-keep">
            {team.name}에 참여했어요
          </h1>
          <p className="text-sm leading-[1.5] text-muted-foreground break-keep">
            {leader && leader !== me ? `${leader} 님의 초대로 들어왔어요. ` : ""}이제 팀원들과 결정을 나눌 수 있어요.
          </p>
        </div>

        <dl className="space-y-3 rounded-[12px] border border-card-border bg-[#faf6f0] px-5 py-4 text-[13px] leading-[1.5]">
          <InfoRow label="프로젝트 주제">{team.topic}</InfoRow>
          {team.deadline && <InfoRow label="마감일">{team.deadline.replaceAll("-", ". ")}</InfoRow>}
          <InfoRow label={`팀원 ${names.length}명`}>
            <span className="flex flex-wrap items-center gap-3">
              <AvatarStack names={names} />
              <span className="text-xs font-normal text-muted-foreground">{names.map((n) => (n === me ? `${n}(나)` : n)).join(" · ")}</span>
            </span>
          </InfoRow>
        </dl>

        <div className="space-y-2.5">
          <h2 className="text-sm leading-[1.5] font-medium">다음 단계</h2>
          <ol className="space-y-2.5">
            {NEXT_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-medium">{i + 1}</span>
                <span className="leading-[1.5]">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="block text-xs text-muted-foreground">{s.desc}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-xs leading-[1.5] text-muted-foreground break-keep">
          팀 연결 정보는 로그인한 계정으로 자동으로 이어져요. 키 파일이나 팀 ID를 따로 넣지 않아도 돼요.
        </p>
        <Link href="/install" className={cn(wide, "bg-brand text-white hover:bg-brand-hover")}>
          브라우저 확장 설치하기
        </Link>
        <Link href="/board" className={cn(wide, "border border-card-border bg-white hover:bg-surface-soft")}>
          나중에 할게요 · 팀 화면으로
        </Link>
      </section>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-[84px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-keep">{children}</dd>
    </div>
  );
}
