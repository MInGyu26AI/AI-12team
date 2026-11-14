"use client";

import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import { card, chip } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 피그마 Page 9 · 0-1 로그인 (300:2). 사용자 결정(11/15): GitHub 로그인은 실제로 동작하고 Google·카카오는 '준비 중'.
// GitHub 로그인은 팀 연결 키 받기 화면(/connect, PR #9)이 이어 받는다: 이 PC의 연결 프로그램이 키를 만들고 웹은 키를 보지 않는다
const SOON = "Google·카카오 로그인은 준비 중이에요. 지금은 GitHub로 로그인해 주세요.";

// 개인정보 처리방침은 팀 레포 문서로 연결한다 (웹에 따로 만든 약관 화면이 없다)
const PRIVACY_URL = "https://github.com/MInGyu26AI/AI-12team/blob/main/docs/privacy.md";

const provider = "flex w-full items-center justify-center gap-2.5 rounded-[10px] py-[13px] text-[15px] leading-[1.5] font-medium";

export default function LoginPage() {
  return (
    <div className="flex justify-center px-gutter pt-12 pb-24 sm:pt-[72px]">
      <section className={cn(card, "w-full max-w-[460px] space-y-5 rounded-2xl px-6 pt-10 pb-9 sm:px-10")} aria-labelledby="login-title">
        <div className="space-y-1.5">
          <h1 id="login-title" className="text-2xl leading-[1.5] font-medium">
            로그인
          </h1>
          <p className="text-sm leading-[1.5] text-muted-foreground break-keep">팀 프로젝트 대화에서 결정만 모아, 내가 승인한 것만 나눠요.</p>
        </div>

        <Link href="/connect" className={cn(provider, "bg-brand text-white hover:bg-brand-hover")}>
          <Image src="/brand/github.svg" alt="" width={18} height={18} unoptimized className="brightness-0 invert" />
          GitHub로 계속하기
        </Link>
        <SoonButton className="border border-card-border bg-white text-foreground">
          <Image src="/brand/google-g.svg" alt="" width={18} height={18} unoptimized />
          Google로 계속하기
        </SoonButton>
        <SoonButton className="bg-[#fee500] text-black/85">
          <Image src="/brand/kakao-symbol.svg" alt="" width={18} height={18} unoptimized />
          카카오로 계속하기
        </SoonButton>

        <p className="text-xs leading-[1.5] text-muted-foreground break-keep">
          팀 관리자가 미리 등록한 GitHub 계정으로 들어와요. 로그인하면 이 PC에 팀 연결 키가 저장되고, 키는 PC 밖으로 나가지 않아요.
        </p>
        <p className="text-xs leading-[1.5] text-muted-foreground">
          계속하면{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="font-medium text-foreground underline">
            개인정보 처리방침
          </a>
          에 동의하게 돼요.
        </p>
      </section>
    </div>
  );
}

// 준비 중인 로그인: 모양은 피그마 그대로 두고, 누르면 안내만 한다
function SoonButton({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-disabled="true" onClick={() => toast.info(SOON)} className={cn(provider, "relative cursor-not-allowed", className)}>
      {children}
      <span className={cn(chip, "absolute right-3 bg-black/6 py-0.5 text-[11px] text-current/70")}>준비 중</span>
    </button>
  );
}
