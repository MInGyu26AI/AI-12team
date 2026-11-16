import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { STEPS } from "@/lib/guide-steps";
import { START } from "@/lib/start-link";
import { cn } from "@/lib/utils";
import { EnTitle } from "@/components/page-title";
import { BurstIcon } from "@/components/ui/burst-icon";
import { Sentences } from "@/components/ui/sentences";

export const metadata: Metadata = {
  title: "이용 방법 · Sync up",
  description: "팀 연결부터 팀 결정 기록까지, Sync up을 쓰는 6단계",
};

const FAQ = [
  {
    q: "확장 프로그램 없이도 쓸 수 있나요?",
    a: "현재 운영 웹은 PC 연결 프로그램과 확장이 필요해요. 자동 수집을 사용하지 않아도 대화 수집 화면의 ‘대화 직접 붙여넣기’에서 AI 대화를 붙여넣거나 ChatGPT 내보내기 파일(zip·conversations.json)을 올리면 같은 승인 절차를 거쳐요. 파일은 브라우저 안에서만 열려요.",
  },
  {
    q: "개인적인 대화도 팀에 올라가나요?",
    a: "아니요. 팀에는 승인함에서 내가 체크한 카드만 올라가고, 원본 대화 전체는 팀에 보내지 않아요. 자동 수집은 설정한 범위와 기간의 대화를 읽고, AI가 팀과 관련된 내용을 골라요. 원문은 이 기기에만 남았다가, 그 대화 묶음의 처리가 모두 끝나고 7일이 지나면 지워져요.",
  },
  {
    q: "단톡방 대화를 붙여넣어도 되나요?",
    a: "‘[이름] 내용’ 형식이면 줄마다 그 말을 한 사람을 결정자로 봐요. 붙여넣은 사람이 아니라 실제로 정한 사람이 기록돼요.",
  },
  {
    q: "Claude나 Gemini도 되나요?",
    a: "지금은 ChatGPT 웹을 지원하고, Claude·Gemini 웹은 지원할 예정이에요. 그 전에는 대화를 붙여넣어 쓸 수 있어요.",
  },
];

export default function GuidePage() {
  return (
    <>
      <section className="bg-gradient-to-b from-brand-soft/80 to-background">
        <div className="mx-auto max-w-content px-gutter pt-16 pb-12 text-center">
          <EnTitle>How it works.</EnTitle><h1 className="mt-5 text-3xl font-bold break-keep sm:text-4xl">6단계면 팀 결정이 하나로 모여요</h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground break-keep">
            <Sentences>{"한 번 설정해 두면 평소처럼 AI와 대화하기만 하면 돼요. 단계마다 버튼을 누르면 해당 화면으로 바로 가요."}</Sentences>
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-content px-gutter py-10">
        <ol className="relative space-y-4 before:absolute before:top-4 before:bottom-4 before:left-[19px] before:w-px before:bg-border">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative flex gap-4">
              <span className="z-10 flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 rounded-xl border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="text-lg font-bold">{s.title}</h2>
                  <Link href={s.href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8")}>
                    {s.cta}
                    <ArrowRight />
                  </Link>
                </div>
                <p className="mt-2 text-sm text-muted-foreground break-keep"><Sentences>{s.body}</Sentences></p>
                <p className="mt-3 flex items-start gap-2 bg-blush px-3 py-2 text-xs text-foreground/80 break-keep">
                  <BurstIcon className="mt-px size-3.5 text-ink" />
                  <span><Sentences>{s.tip}</Sentences></span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="bg-canvas">
        <div className="mx-auto max-w-content px-gutter py-14">
          <h2 className="text-center text-2xl font-bold">자주 묻는 질문</h2>
          <div className="mt-8 space-y-3">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-xl border bg-card p-5 open:shadow-xs">
                <summary className="cursor-pointer list-none font-semibold marker:hidden">
                  <span className="mr-2 text-brand">Q.</span>
                  {f.q}
                </summary>
                <p className="mt-3 text-sm text-muted-foreground break-keep"><Sentences>{f.a}</Sentences></p>
              </details>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href={START.href} className={cn(buttonVariants({ size: "lg" }), "h-11 bg-brand px-6 hover:bg-brand-hover")}>
              {START.label}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
