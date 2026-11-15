import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ChevronDown, Download } from "lucide-react";
import { AlertPreview, ApprovePreview, ConflictPreview, PastePreview, PopupPreview, RecordPreview } from "@/components/landing/previews";
import release from "@/lib/extension-release.json";
import { START } from "@/lib/start-link";
import { cn } from "@/lib/utils";

// 피그마 1번: 서비스 첫 화면 (147:2). Hero(흩어진 대화가 하나로 모이는 그림 + 'SyncUp이 하는 일' 카드 4개) →
// Section 0~4 (기능별 한 화면 높이 760 · 왼쪽 글 + 오른쪽 제품 미리보기) → 이렇게 사용해요 → Section 5 확장 설치 → (Footer 는 layout)

const JUMPS = [
  { id: "approve", no: "01", title: "프로젝트 대화 · 승인 후 공유", body: "프로젝트 대화에서 결정·할 일·조사를 찾고, 내가 고른 것만 팀에 올려요" },
  { id: "alert", no: "02", title: "실시간 알림", body: "대화하는 자리에서 기존 결정과 어긋나면 바로 알려줘요" },
  { id: "conflict", no: "03", title: "결정 충돌 해결", body: "기존 결정을 유지할지, 새 결정으로 바꿀지 그 자리에서 정해요" },
  { id: "record", no: "04", title: "팀 결정 기록", body: "언제, 누가, 왜 정했는지 쌓이고 새 대화에 붙여 이어 써요" },
];

// Hero 양옆에 흩어진 팀원 대화 (피그마 217:11 ~ 217:29). 위치는 1280 폭 기준 px, 기울기는 피그마 회전값
const SCATTERED = [
  { who: "박지민", c: "지", bg: "#e3dcf2", text: "발표는 목요일로 하자", pos: "left-[72px] top-[109px] rotate-2" },
  { who: "이서준", c: "서", bg: "#cde9f4", text: "MVP는 ChatGPT 웹만", pos: "left-[128px] top-[287px] -rotate-[1.5deg]" },
  { who: "정하린", c: "하", bg: "#fff3a6", text: "PPT 초안은 금요일까지", pos: "left-[972px] top-[123px] -rotate-2" },
  { who: "최유나", c: "유", bg: "#e6d8c4", text: "서비스 이름은 SyncUp", pos: "left-[914px] top-[301px] rotate-[1.5deg]" },
];

const HOW = [
  { title: START.step, body: START.href === "/team/new" ? "팀장이 팀을 만들고 링크로 팀원을 불러요" : "GitHub로 로그인하고 팀을 만들거나 초대로 참여해요", tag: "처음 한 번 · 팀장" },
  { title: "브라우저 확장 연결", body: "Chrome에 확장 프로그램을 추가해요", tag: "처음 한 번 · 모두", link: true },
  { title: "싱크 맞추기", body: "ChatGPT 프로젝트 대화를 SyncUp으로 가져와요", tag: "대화할 때마다" },
  { title: "승인함에서 체크", body: "팀에 올릴 결정·할 일만 골라요", tag: "내가 직접", strong: true },
  { title: "충돌 확인", body: "기존 결정과 다르면 SyncUp이 먼저 알려줘요", tag: "자동" },
  { title: "팀 결정 기록", body: "누가, 언제, 왜 정했는지 한곳에 쌓여요", tag: "자동" },
];

const INSTALL_STEPS = [
  { title: "SyncUp 내려받기", body: "내 컴퓨터(macOS · Windows)에 맞는 SyncUp 파일을 내려받아요. 확장 프로그램과 대화 수집기가 함께 들어 있어요." },
  { title: "Chrome에 추가하기", body: "chrome://extensions에서 '개발자 모드'를 켜고 '압축해제된 확장 프로그램을 로드합니다'로 폴더를 골라요." },
  { title: "팀 연결 확인", body: "확장 팝업에 우리 팀 이름이 보이면 연결된 거예요. 이제 ChatGPT를 열면 돼요." },
];

const primaryLg = "inline-flex h-12 items-center justify-center gap-2 rounded-[10px] bg-brand px-5 text-base font-medium text-white hover:bg-brand-hover";
const outlineLg = "inline-flex h-12 items-center justify-center rounded-[10px] border border-foreground/10 bg-white px-5 text-base font-medium hover:bg-surface-soft";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Feature
        id="overview"
        step={{ label: "한눈에 보기", sub: "팀 결정 기록" }}
        title={<>팀원들의&nbsp; 대화가<br />한 곳에 모여요</>}
        body={<>누가, 언제, 무엇을 정했는지 날짜순으로 쌓여요.<br />주제·역할·작업별로 묶어서 보여 줘요.</>}
        preview={<RecordPreview />}
      />
      <Feature
        id="approve"
        step={{ index: 1, sub: "프로젝트 대화 · 승인 후 공유" }}
        title={<>프로젝트 대화만 모으고,<br />공유는 내가 정해요</>}
        body="ChatGPT 프로젝트 대화에서 결정·할 일·조사 후보를 찾아요. 내가 체크한 것만 팀에 올라가요. 승인하지 않은 내용은 팀에 보이지 않아요."
        bodyWidth="max-w-[430px]"
        preview={<ApprovePreview />}
      />
      <Feature
        id="alert"
        step={{ index: 2, sub: "대화 중 실시간 알림" }}
        title={<>대화하는 그 자리에서<br />어긋난 결정을 알려줘요</>}
        body="ChatGPT 웹에서 기존 팀 결정과 다른 내용이 나오면 바로 알림이 떠요. 대화를 멈추지 않고 확인할 수 있어요."
        bodyWidth="max-w-[260px]"
        preview={<AlertPreview />}
      />
      <Feature
        id="conflict"
        step={{ index: 3, sub: "결정 충돌 해결" }}
        title={<>엇갈린 결정은<br />그 자리에서 정리해요</>}
        body="기존 결정을 유지할지, 새 결정으로 바꿀지 바로 정해요."
        bodyWidth="max-w-[230px]"
        preview={<ConflictPreview />}
      />
      <Feature
        id="record"
        step={{ index: 4, sub: "팀 결정 기록" }}
        title={<>언제, 누가, 왜 정했는지<br />한 곳에서 이어 써요</>}
        body="팀 기록을 복사해 새 AI 대화에 붙여 넣으면 팀의 맥락이 그대로 이어져요."
        bodyWidth="max-w-[300px]"
        preview={<PastePreview />}
        cta
      />
      <HowTo />
      <Install />
    </>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="relative mx-auto flex max-w-[1280px] flex-col items-center gap-14 px-gutter pt-12 pb-10 sm:px-10 lg:min-h-[736px] lg:px-20 lg:pt-[34px]">
        {/* 흩어진 대화 → 가운데로 모이는 점선 (피그마 에셋 그대로) · 넓은 화면에서만 */}
        <Image
          src="/brand/hero-converge-lines.svg"
          alt=""
          aria-hidden
          width={1280}
          height={736}
          unoptimized
          className="pointer-events-none absolute top-0 left-0 hidden max-w-none lg:block"
        />
        {SCATTERED.map((s) => (
          <div
            key={s.who}
            aria-hidden
            className={cn(
              "absolute hidden space-y-1.5 rounded-[14px] border border-foreground/8 bg-white px-3.5 py-3 shadow-[0_8px_24px_rgb(0_0_0/0.06)] lg:block",
              s.pos,
            )}
          >
            <p className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
              <span className="flex size-[18px] items-center justify-center rounded-full text-[10px] font-medium text-foreground" style={{ background: s.bg }}>
                {s.c}
              </span>
              {s.who} · ChatGPT
            </p>
            <p className="text-sm font-medium whitespace-nowrap">{s.text}</p>
          </div>
        ))}

        <div className="relative flex flex-col items-center text-center">
          <HeroWordmark />
          <h1 className="mt-5 text-4xl leading-tight font-medium tracking-[-0.02em] break-keep sm:text-[56px] sm:leading-[normal]">
            각자 쓴 ChatGPT,
            <br />
            팀의 결정은{" "}
            <span className="relative inline-block">
              {/* 노란 형광펜 (피그마 147:27: #ffeb3b, 높이 24, 글자 아래쪽) */}
              <span aria-hidden className="absolute -inset-x-[3px] bottom-[0.12em] h-[0.43em] rounded-[2px] bg-[#ffeb3b]" />
              <span className="relative">하나로</span>
            </span>
          </h1>
          <p className="mt-6 text-base leading-[1.6] text-muted-foreground break-keep sm:text-lg">
            프로젝트 대화에서 결정·할 일·조사만 골라 모아요.
            <br />
            내가 승인한 것만 팀과 나누고, 어긋나면 먼저 알려드려요.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href={START.href} className={primaryLg}>
              {START.label}
            </Link>
            <Link href="/install" className={outlineLg}>
              브라우저 확장 설치
            </Link>
          </div>
        </div>

        <div className="relative w-full max-w-[1056px] space-y-3.5">
          <p className="text-center text-[13px] text-text-tertiary">SyncUp이 하는 일 · 누르면 바로 그 부분으로 이동해요</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {JUMPS.map((j) => (
              <a
                key={j.id}
                href={`#${j.id}`}
                className="flex flex-col gap-2 rounded-[14px] border border-foreground/8 bg-white px-5 py-[18px] text-left transition-colors hover:border-foreground/20"
              >
                <span className="text-[13px] font-medium text-text-tertiary">{j.no}</span>
                <span className="text-[17px] font-medium">{j.title}</span>
                <span className="text-[13px] text-muted-foreground break-keep">{j.body}</span>
                <span className="mt-1 flex items-center gap-1 text-xs font-medium">
                  바로 보기 <ArrowDown className="size-3.5" aria-hidden />
                </span>
              </a>
            ))}
          </div>
        </div>
        <p className="relative flex items-center gap-2 text-[13px] text-text-tertiary">
          아래로 내리면 기능을 하나씩 보여드려요 <ChevronDown className="size-4" aria-hidden />
        </p>
      </div>
    </section>
  );
}

// 큰 워드마크 (피그마 239:2): Fredoka Bold 44px + 오른쪽 위로 올라가는 코랄 밑줄 (에셋 그대로)
function HeroWordmark() {
  return (
    <span className="relative block h-[57.56px] w-[175.84px] translate-x-[13.2px]">
      <Image src="/brand/hero-wordmark-underline.svg" alt="" aria-hidden width={175.84} height={51.4} unoptimized className="absolute top-[6.16px] left-0 max-w-none" />
      <span className="absolute top-0 left-0 font-brand text-[44px] leading-[normal] font-bold whitespace-nowrap text-brand">SyncUp</span>
    </span>
  );
}

type Step = { label?: string; index?: number; sub: string };

function StepLine({ step }: { step: Step }) {
  return (
    <p className="flex flex-wrap items-center gap-3 text-[13px]">
      <span className="font-medium">{step.label ?? `0${step.index} / 04`}</span>
      {step.index && (
        <span aria-hidden className="flex gap-1">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={cn("h-0.5 w-5 rounded-[1px]", i === step.index ? "bg-brand" : "bg-foreground/12")} />
          ))}
        </span>
      )}
      <span className="text-text-tertiary">{step.sub}</span>
    </p>
  );
}

// 기능 섹션 (피그마 Section 0~4): 위 구분선 · 넓은 화면 높이 760 · 왼쪽 글 472 + 오른쪽 미리보기 560
function Feature({ id, step, title, body, bodyWidth, preview, cta }: {
  id: string;
  step: Step;
  title: React.ReactNode;
  body: React.ReactNode;
  bodyWidth?: string;
  preview: React.ReactNode;
  cta?: boolean;
}) {
  return (
    <section id={id} className="scroll-mt-16 border-t border-foreground/8">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-12 px-gutter py-16 sm:px-10 lg:min-h-[760px] lg:flex-row lg:items-center lg:px-20 lg:py-0">
        <div className="lg:w-[472px] lg:shrink-0">
          <StepLine step={step} />
          <h2 className="mt-6 text-3xl leading-[1.28] font-medium tracking-[-0.015em] break-keep sm:text-[42px]">{title}</h2>
          <p className={cn("mt-5 text-base leading-[1.65] text-muted-foreground break-keep sm:text-[17px]", bodyWidth)}>{body}</p>
          {cta && (
            <Link href={START.href} className={cn(primaryLg, "mt-9")}>
              {START.label}
            </Link>
          )}
        </div>
        <div className="flex min-w-0 flex-1 justify-center lg:justify-start">{preview}</div>
      </div>
    </section>
  );
}

// 이렇게 사용해요 (149:108): 옅은 베이지 띠 · 6단계 번호 + 이어지는 선 · 단계마다 태그
function HowTo() {
  return (
    <section id="how" className="scroll-mt-16 border-t border-foreground/8 bg-[#e6d8c4]/40">
      <div className="mx-auto max-w-[1280px] space-y-10 px-gutter py-16 sm:px-10 lg:px-20 lg:py-24">
        <h2 className="text-[32px] font-medium tracking-[-0.01em]">이렇게 사용해요</h2>
        <ol className="grid gap-8 sm:grid-cols-3 lg:grid-cols-6 lg:gap-0">
          {HOW.map((s, i) => (
            <li key={s.title} className="flex flex-col items-start gap-3 lg:pr-2">
              <span className="flex w-full items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-foreground/15 bg-white text-xs font-medium">{i + 1}</span>
                {i < HOW.length - 1 && <span aria-hidden className="hidden h-px flex-1 bg-foreground/15 lg:block" />}
              </span>
              <span className="text-[15px] font-medium">{s.title}</span>
              <span className="max-w-[172px] text-[13px] text-muted-foreground break-keep">{s.body}</span>
              <span className={cn("rounded-md px-2 py-[3px] text-[11px] font-medium", s.strong ? "bg-brand text-white" : "bg-foreground/6 text-muted-foreground")}>{s.tag}</span>
              {s.link && (
                <Link href="/install" className="text-xs font-medium hover:underline">
                  설치 방법 보기 →
                </Link>
              )}
            </li>
          ))}
        </ol>
        <p className="text-[13px] text-text-tertiary">지금은 ChatGPT 웹을 지원해요. Claude와 Gemini는 준비 중이에요.</p>
      </div>
    </section>
  );
}

// Section 5 · 브라우저 확장 설치 (248:2)
function Install() {
  const version = release.version.split(".").slice(0, 2).join(".");
  return (
    <section id="install" className="scroll-mt-16 border-t border-foreground/8">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-16 px-gutter py-16 sm:px-10 lg:flex-row lg:items-center lg:px-20 lg:py-24">
        <div className="lg:w-[520px] lg:shrink-0">
          <p className="flex flex-wrap gap-2.5 text-[13px]">
            <span className="font-medium">브라우저 확장</span>
            <span className="text-text-tertiary">Chrome 데스크톱 · macOS · Windows</span>
          </p>
          <h2 className="mt-6 text-3xl font-medium sm:text-[42px]">3단계면 준비 끝나요</h2>
          <p className="mt-4 max-w-[480px] text-base text-muted-foreground break-keep sm:text-[17px]">
            설치는 한 번만 하면 돼요. 그다음부터는 ChatGPT에서 평소처럼 대화하면 돼요.
          </p>
          <ol className="mt-8 space-y-5">
            {INSTALL_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-foreground/25 bg-white text-[13px] font-medium">{i + 1}</span>
                <span className="space-y-1">
                  <span className="block text-[17px] font-medium">{s.title}</span>
                  <span className="block max-w-[430px] text-sm text-muted-foreground break-keep">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex items-center gap-3">
            <Link href="/install" className={primaryLg}>
              <Download className="size-[18px]" aria-hidden />
              확장 프로그램 받기
            </Link>
            <span className="text-[13px] text-text-tertiary">v{version} · 무료</span>
          </div>
          <p className="mt-5 text-[13px] text-text-tertiary">휴대폰에서는 설치할 수 없어요</p>
        </div>
        <div className="flex min-w-0 flex-1 justify-center">
          <PopupPreview />
        </div>
      </div>
    </section>
  );
}
