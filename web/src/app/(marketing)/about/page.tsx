import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, GitCompareArrows, Layers, MessagesSquare, ShieldCheck, Shuffle, UserCheck, Zap } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "서비스 소개 · Sync up",
  description: "팀원마다 다른 AI를 써도 팀의 결정은 하나로 — Sync up이 푸는 문제와 차별점",
};

const PROBLEMS = [
  { icon: Shuffle, title: "팀원마다 다른 AI", body: "누구는 ChatGPT, 누구는 Claude·Gemini. 무료 AI를 섞어 쓰면 대화가 각자 계정에 흩어져요." },
  { icon: MessagesSquare, title: "결정이 대화 속에 묻힘", body: "“서비스명은 이걸로 하자”, “내가 금요일까지 할게” 같은 말이 긴 AI 대화 사이에 묻혀 다시 찾기 어려워요." },
  { icon: GitCompareArrows, title: "모르는 사이 엇갈린 결정", body: "한 사람은 ‘확장은 나중에’, 다른 사람은 ‘확장도 MVP에’라고 정해도 아무도 눈치채지 못해요." },
];

const DIFFERENTIATORS = [
  {
    icon: GitCompareArrows,
    title: "결정 충돌 감지",
    body: "새로 올라온 결정을 같은 주제의 기존 결정과 비교해 같음·변경·충돌을 판정하고, 어긋나면 근거 문장과 함께 먼저 알려줘요.",
  },
  {
    icon: UserCheck,
    title: "본인 승인 후 공유",
    body: "AI가 고른 후보는 내 승인함에만 쌓여요. 내가 체크한 카드만 팀에 올라가고, 원본 대화 전체는 팀 서버로 가지 않아요.",
  },
  {
    icon: Zap,
    title: "설치 부담 없이 누구나",
    body: "브라우저 확장 하나면 ChatGPT 대화를 10회마다 자동으로 모아요. 확장을 못 써도 대화 붙여넣기·내보내기 파일로 쓸 수 있어요.",
  },
];

const PRIVACY = [
  "처음 설정할 때 무엇을 수집하고 무엇을 외부 AI로 보내는지 먼저 안내해요.",
  "점심·약속·병원 같은 개인 내용은 버리고, 전화번호·이메일·계좌·주민번호는 외부 AI로 보내기 전에 가려요.",
  "팀 서버에는 내가 승인한 카드와 확인한 근거 문장만 올라가요.",
  "수집 종료 시각이 지나면 새 대화 수집과 외부 전송을 멈춰요. 언제든 일시정지할 수 있어요.",
];

export default function AboutPage() {
  return (
    <>
      <section className="bg-gradient-to-b from-brand-soft/80 to-background">
        <div className="mx-auto max-w-content px-gutter pt-16 pb-14 text-center">
          <span className="rounded-full bg-background px-3 py-1 text-xs font-semibold text-brand shadow-xs">서비스 소개</span>
          <h1 className="mt-5 text-3xl leading-tight font-bold break-keep sm:text-4xl">
            흩어진 AI 대화 속 팀 결정을
            <br />
            하나의 기록으로
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground break-keep">
            Sync up은 무료 AI를 섞어 쓰는 대학생 해커톤·팀플 팀을 위한 공유 메모리예요. 각자의 AI 대화에서 팀에 필요한 결정·조사·할 일을
            골라, 내가 승인한 것만 팀과 나누고, 결정이 어긋나면 먼저 알려줘요.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-wide px-gutter py-14">
        <h2 className="text-center text-2xl font-bold">팀플에서 이런 일, 겪어 봤죠?</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {PROBLEMS.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border bg-card p-6">
              <Icon className="size-6 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-bold">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground break-keep">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-canvas">
        <div className="mx-auto max-w-wide px-gutter py-14">
          <h2 className="text-center text-2xl font-bold">Sync up은 이렇게 달라요</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {DIFFERENTIATORS.map(({ icon: Icon, title, body }, i) => (
              <div key={title} className="rounded-xl border bg-card p-6">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Icon className="size-5" />
                  </span>
                  <span className="text-xs font-semibold text-brand">차별점 {i + 1}</span>
                </div>
                <h3 className="mt-4 text-lg font-bold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground break-keep">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-wide gap-6 px-gutter py-14 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-6">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Layers className="size-5 text-brand" />
            AI가 대화를 이렇게 나눠요
          </h2>
          <ul className="mt-4 space-y-3 text-sm">
            <li>
              <span className="mr-2 rounded-full bg-tag-decision-soft px-2 py-0.5 text-xs font-semibold text-tag-decision">결정</span>
              팀이 확정·합의·변경한 내용 → 충돌 비교 대상
            </li>
            <li>
              <span className="mr-2 rounded-full bg-tag-todo-soft px-2 py-0.5 text-xs font-semibold text-tag-todo">할 일</span>
              누군가 해야 할 작업 → 담당자·기한까지
            </li>
            <li>
              <span className="mr-2 rounded-full bg-tag-research-soft px-2 py-0.5 text-xs font-semibold text-tag-research">조사</span>
              알게 된 사실·자료·외부 조건 → 참고 자료
            </li>
            <li>
              <span className="mr-2 rounded-full bg-tag-personal-soft px-2 py-0.5 text-xs font-semibold text-tag-personal">개인</span>
              프로젝트와 상관없는 내용 → 저장하지 않음
            </li>
          </ul>
          <p className="mt-4 text-xs text-muted-foreground break-keep">
            AI가 추천만 한 내용이나 “~하면 어때?” 같은 제안은 결정으로 치지 않아요. 팀이 받아들였을 때만 결정이 돼요.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-6">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <ShieldCheck className="size-5 text-ok" />
            개인정보는 이렇게 지켜요
          </h2>
          <ul className="mt-4 space-y-3 text-sm">
            {PRIVACY.map((p) => (
              <li key={p} className="flex gap-2 break-keep">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-content px-gutter pb-16 text-center">
        <p className="text-sm text-muted-foreground">지금은 ChatGPT 웹을 지원하고, Claude·Gemini는 곧 지원해요.</p>
        <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/guide" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "h-11 px-6")}>
            이용 방법 보기
          </Link>
          <Link href="/team/new" className={cn(buttonVariants({ size: "lg" }), "h-11 bg-brand px-6 hover:bg-brand-hover")}>
            팀 만들고 시작하기
          </Link>
        </div>
      </section>
    </>
  );
}
