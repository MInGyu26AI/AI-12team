import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { USE_MOCK } from "@/lib/api";
import { START } from "@/lib/start-link";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "이용 방법 · Sync up",
  description: "팀 연결부터 팀 결정 기록까지, Sync up을 쓰는 6단계",
};

// 첫 단계는 모드마다 다르다: 목업은 이 브라우저에 팀을 만들고, 실제는 관리자가 등록한 팀을 확인한다
const FIRST_STEP = USE_MOCK
  ? {
      title: START.step,
      body: "팀 이름, 프로젝트 주제, 마감일을 입력해요. 프로젝트 주제는 AI가 팀 관련 대화를 고르는 기준이 돼요. 초대 링크를 카카오톡·디스코드에 보내면 팀원이 바로 참여해요.",
      tip: "예시 모드에서는 팀 정보가 이 브라우저에만 저장돼요.",
      href: START.href,
      cta: START.short,
    }
  : {
      title: START.step,
      body: "팀과 사용자는 관리자가 미리 등록해요. 로컬 수집기를 실행한 뒤 대화 수집 화면에서 승인 대상 팀과 프로젝트 주제를 확인해요. 프로젝트 주제는 AI가 팀 관련 대화를 고르는 기준이 돼요.",
      tip: "초대 링크만으로는 팀에 들어갈 수 없어요. 소속이 없으면 관리자에게 등록을 요청하세요.",
      href: START.href,
      cta: "대화 수집 화면",
    };

const STEPS = [
  FIRST_STEP,
  {
    title: "브라우저 확장 연결",
    body: "크롬 확장 zip을 내려받아 압축을 풀고, chrome://extensions 의 개발자 모드에서 ‘압축해제된 확장 프로그램 로드’로 설치해요. 툴바에 고정해 두면 편해요.",
    tip: "처음 설정에서 수집 범위와 외부 AI 전송 안내를 꼭 읽어 주세요.",
    href: "/install",
    cta: "설치 방법 보기",
  },
  {
    title: "대화 자동 수집",
    body: "평소처럼 ChatGPT 웹에서 대화하면 확장이 질문+답변 10회마다 대화를 모아 분류해요. 횟수는 대화 수집 화면에서 바꿀 수 있고, 개인적인 대화를 할 땐 일시정지하세요.",
    tip: "자동으로 못 읽으면 대화를 드래그해 오른쪽 아래 ‘선택한 내용 보내기’를 누르거나, 대화를 직접 붙여넣어도 돼요.",
    href: "/collect",
    cta: "대화 수집 화면",
  },
  {
    title: "승인함에서 체크",
    body: "AI가 고른 결정·조사·할 일 후보가 내 승인함에 쌓여요. 내용을 확인·수정하고 팀에 올릴 것만 체크해서 올려요. 개인 내용은 기본으로 빠지고, 확신도가 낮으면 ‘확인 필요’가 붙어요.",
    tip: "승인함은 나만 봐요. 체크하지 않은 후보는 팀에 올라가지 않아요.",
    href: "/review",
    cta: "승인함 열기",
  },
  {
    title: "충돌 확인",
    body: "올린 결정이 같은 주제의 기존 결정과 어긋나면 두 결정과 근거 문장을 나란히 보여줘요. ‘기존 유지’, ‘새 결정으로 변경’, ‘팀에 논의 요청’ 중 하나를 골라요.",
    tip: "같은 사람이 스스로 고친 건 ‘변경’, 다른 사람이 반대로 정한 건 ‘충돌’로 표시돼요.",
    href: "/board",
    cta: "충돌 확인하기",
  },
  {
    title: "팀 결정 기록",
    body: "승인된 결정이 주제별·시간순으로 쌓이고, 할 일은 담당자·기한과 함께 체크할 수 있어요. ‘팀 기록 복사’를 누르면 지금까지의 결정을 AI에 붙여넣기 좋은 글로 복사해요.",
    tip: "새 AI 대화를 시작할 때 팀 기록을 붙여넣으면 팀이 정한 내용을 전제로 답해 줘요.",
    href: "/board",
    cta: "팀 결정 기록 보기",
  },
];

const FAQ = [
  {
    q: "확장 프로그램 없이도 쓸 수 있나요?",
    a: "네. 대화 수집 화면의 ‘대화 직접 붙여넣기’에서 AI 대화를 붙여넣거나 ChatGPT 내보내기 파일(zip·conversations.json)을 올리면 같은 승인 절차를 거쳐요. 파일은 브라우저 안에서만 열려요.",
  },
  {
    q: "개인적인 대화도 팀에 올라가나요?",
    a: "아니요. 이 기기의 개인정보 검사가 개인 내용으로 본 발화는 외부 AI와 팀 서버로 보내지 않아요. 원문은 이 기기에만 남았다가, 그 대화 묶음의 처리가 모두 끝나고 7일이 지나면 지워져요. 팀에는 승인함에서 내가 체크한 카드만 올라가요.",
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
          <span className="rounded-full bg-background px-3 py-1 text-xs font-semibold text-brand shadow-xs">이용 방법</span>
          <h1 className="mt-5 text-3xl font-bold break-keep sm:text-4xl">6단계면 팀 결정이 하나로 모여요</h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground break-keep">
            한 번 설정해 두면 평소처럼 AI와 대화하기만 하면 돼요. 단계마다 버튼을 누르면 해당 화면으로 바로 가요.
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
                <p className="mt-2 text-sm text-muted-foreground break-keep">{s.body}</p>
                <p className="mt-3 rounded-lg bg-brand-soft/60 px-3 py-2 text-xs text-foreground/80 break-keep">💡 {s.tip}</p>
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
                <p className="mt-3 text-sm text-muted-foreground break-keep">{f.a}</p>
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
