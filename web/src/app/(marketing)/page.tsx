import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 피그마 1번: 서비스 첫 화면
const FEATURES = [
  { title: "자동 수집", body: "ChatGPT 웹 대화를 10회마다\n자동으로 모아요." },
  { title: "본인 승인", body: "결정·조사·할 일 후보 중\n내가 체크한 것만 팀에 올라가요." },
  { title: "충돌 감지", body: "새 결정이 기존 결정과 어긋나면\n바로 알려줘요." },
  { title: "결정 기록", body: "언제, 누가, 왜 정했는지 쌓이고\n복사해서 바로 이어 써요." },
];

const STEPS = ["팀 만들기·초대", "브라우저 확장 연결", "대화 자동 수집", "승인함에서 체크", "충돌 확인", "팀 결정 기록"];

export default function LandingPage() {
  return (
    <>
      <section className="bg-gradient-to-b from-brand-soft/80 to-background">
        <div className="mx-auto flex max-w-wide flex-col items-center px-gutter pt-20 pb-24 text-center sm:pt-24">
          <span className="rounded-full bg-background px-3 py-1 text-xs font-semibold text-brand shadow-xs">
            대학생 팀플을 위한 AI 공유 메모리
          </span>
          <h1 className="mt-6 text-4xl leading-tight font-bold tracking-tight break-keep sm:text-5xl sm:leading-[1.2]">
            팀원마다 다른 AI를 써도
            <br />팀의 결정은 하나로
          </h1>
          <p className="mt-6 max-w-xl text-base text-muted-foreground break-keep sm:text-lg">
            ChatGPT 대화 속 결정·조사·할 일을 자동으로 모으고,
            <br className="hidden sm:block" /> 내가 승인한 것만 팀과 나누며, 결정이 어긋나면 먼저 알려드려요.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/team/new" className={cn(buttonVariants({ size: "lg" }), "h-12 bg-brand px-7 text-base hover:bg-brand-hover")}>
              팀 만들고 시작하기
            </Link>
            <Link href="/install" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "h-12 bg-background px-7 text-base")}>
              브라우저 확장 설치
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
            지원하는 AI
            <span className="rounded-full bg-ok-soft px-2.5 py-1 text-xs font-semibold text-ok">ChatGPT 지원 중</span>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">Claude · Gemini 곧 지원</span>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-wide scroll-mt-20 px-gutter py-20">
        <h2 className="text-center text-3xl font-bold">Sync up이 하는 일</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="rounded-xl border bg-card p-6">
              <span className="flex size-9 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">{i + 1}</span>
              <h3 className="mt-5 text-lg font-bold">{f.title}</h3>
              <p className="mt-2 text-sm whitespace-pre-line text-muted-foreground break-keep">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="scroll-mt-20 bg-canvas">
        <div className="mx-auto max-w-wide px-gutter py-20">
          <h2 className="text-center text-3xl font-bold">이렇게 사용해요</h2>
          <ol className="mt-10 flex flex-wrap items-center justify-center gap-x-2 gap-y-3">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-2">
                <span className="rounded-full border bg-background px-4 py-2.5 text-sm font-medium">
                  {i + 1}. {s}
                </span>
                {i < STEPS.length - 1 && <ArrowRight className="size-4 text-muted-foreground" />}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
