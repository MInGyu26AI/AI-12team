import Link from "next/link";
import { ChevronDown, Download } from "lucide-react";
import { AlertPreview, ApprovePreview, ConflictPreview, PastePreview, PopupPreview, RecordPreview } from "@/components/landing/previews";
import { RollSteps, type RollStep } from "@/components/landing/roll-steps";
import { StagesMotion } from "@/components/landing/stages-motion";
import { WatercolorBg } from "@/components/ui/watercolor-bg";
import release from "@/lib/extension-release.json";
import { START } from "@/lib/start-link";
import { cn } from "@/lib/utils";

// 서비스 첫 화면. Hero(별의 일생 상자 + 영어 제목 + 4단계 롤 링크, 시안 "로즈 & 올리브 수채화") →
// Section 0~4 (기능별 한 화면 높이 760 · 왼쪽 글 + 오른쪽 제품 미리보기) → 이렇게 사용해요 → Section 5 확장 설치 → (Footer 는 layout)

// 4단계 롤 링크 (components/landing/roll-steps.tsx). 한국어 제목·설명은 예전 'SyncUp이 하는 일' 카드 그대로, 영어 단어·한 줄은 시안
const STEPS: RollStep[] = [
  { id: "approve", no: "01", word: "Approve", line: "Only what you approve.", title: "프로젝트 대화 · 승인 후 공유", body: "프로젝트 대화에서 결정·할 일·조사를 찾고, 내가 고른 것만 팀에 올려요" },
  { id: "alert", no: "02", word: "Alert", line: "Clashes, flagged first.", title: "실시간 알림", body: "대화하는 자리에서 기존 결정과 어긋나면 바로 알려줘요" },
  { id: "conflict", no: "03", word: "Resolve", line: "Side by side, settled.", title: "결정 충돌 해결", body: "기존 결정을 유지할지, 새 결정으로 바꿀지 그 자리에서 정해요" },
  { id: "record", no: "04", word: "Record", line: "Burst into the record.", title: "팀 결정 기록", body: "언제, 누가, 왜 정했는지 쌓이고 새 대화에 붙여 이어 써요" },
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

const heroPrimary = "button-mono inline-flex h-12 items-center justify-center gap-2 border border-ink bg-ink px-6 text-[14px] text-white hover:bg-brand-hover";
const heroOutline = "button-mono inline-flex h-12 items-center justify-center gap-2 border border-ink px-6 text-[14px] text-ink hover:bg-white";
const primaryLg = "button-mono inline-flex h-12 items-center justify-center gap-2 border border-ink bg-ink px-6 text-[15px] text-white hover:bg-brand-hover";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Feature
        id="overview"
        en="Every chat, one record."
        step={{ label: "한눈에 보기", sub: "팀 결정 기록" }}
        title={<>팀원들의&nbsp; 대화가<br />한 곳에 모여요</>}
        body={<>누가, 언제, 무엇을 정했는지 날짜순으로 쌓여요.<br />주제·역할·작업별로 묶어서 보여 줘요.</>}
        preview={<RecordPreview />}
      />
      <Feature
        id="approve"
        en="Only what you approve."
        step={{ index: 1, sub: "프로젝트 대화 · 승인 후 공유" }}
        title={<>프로젝트 대화만 모으고,<br />공유는 내가 정해요</>}
        body="ChatGPT 프로젝트 대화에서 결정·할 일·조사 후보를 찾아요. 내가 체크한 것만 팀에 올라가요. 승인하지 않은 내용은 팀에 보이지 않아요."
        bodyWidth="max-w-[430px]"
        preview={<ApprovePreview />}
      />
      <Feature
        id="alert"
        en="Clashes, flagged first."
        step={{ index: 2, sub: "대화 중 실시간 알림" }}
        title={<>대화하는 그 자리에서<br />어긋난 결정을 알려줘요</>}
        body="ChatGPT 웹에서 기존 팀 결정과 다른 내용이 나오면 바로 알림이 떠요. 대화를 멈추지 않고 확인할 수 있어요."
        bodyWidth="max-w-[260px]"
        preview={<AlertPreview />}
      />
      <Feature
        id="conflict"
        en="Side by side, settled."
        step={{ index: 3, sub: "결정 충돌 해결" }}
        title={<>엇갈린 결정은<br />그 자리에서 정리해요</>}
        body="기존 결정을 유지할지, 새 결정으로 바꿀지 바로 정해요."
        bodyWidth="max-w-[230px]"
        preview={<ConflictPreview />}
      />
      <Feature
        id="record"
        en="Burst into the record."
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

// 히어로 (시안 "로즈 & 올리브 수채화"): 수채화 번짐 위에 11초 4단계 애니메이션 상자 → 영어 큰 제목 + 한국어 설명 → 버튼 2개 → 4단계 롤 링크
function Hero() {
  return (
    <section className="relative overflow-hidden">
      <WatercolorBg />
      <div className="relative mx-auto flex max-w-[1280px] flex-col gap-12 px-gutter pb-14 sm:px-10 lg:px-20">
        {/* 첫 화면: 헤더(65px) 아래 남은 높이 안에서 상자를 위아래 가운데에 둔다 (위·아래 여백이 같다).
            상자는 stages-motion 의 2:1 비율(1200×600). -mb-12 는 gap-12 를 지워 제목까지 간격을 아래 여백(48px) 하나로 둔다 */}
        <div className="-mb-12 flex flex-col justify-center pt-10 pb-12 md:min-h-[calc(100svh-65px)] md:pt-12">
          <StagesMotion />
        </div>

        {/* 제목 영역: 왼쪽 영어 큰 제목 / 오른쪽 이름 뜻·설명·버튼 (아래 정렬, 좁으면 줄바꿈) */}
        <div className="flex flex-wrap items-end gap-x-12 gap-y-8">
          <h1
            className="min-w-0 font-display font-extrabold text-ink"
            style={{ flex: "1 1 560px", fontSize: "clamp(52px, 7.2vw, 108px)", lineHeight: 0.96, letterSpacing: "-0.055em" }}
          >
            Scattered chats,
            <br />
            one <span className="font-serif font-normal tracking-normal italic">decision.</span>
          </h1>
          <div className="min-w-0 space-y-4" style={{ flex: "1 1 340px" }}>
            <p className="flex items-center gap-3 text-ink">
              <span className="font-mono text-[12px] tracking-[0.24em]">SYNC UP</span>
              <span aria-hidden className="font-serif text-[22px] italic">⟶</span>
              <span className="font-mono text-[12px] tracking-[0.24em]">THINK UP</span>
            </p>
            <p className="text-[17px] leading-[1.65] font-medium break-keep text-ink">
              ‘싱크’는 맞추다(Sync)이면서 떠올리다(Think)예요. 흩어진 대화가 모여 결정이 되고, 그 결정이 터져 다음 생각이 돼요.
            </p>
            <p className="text-[17px] leading-[1.65] break-keep text-ink-body">
              프로젝트 대화에서 결정 · 할 일 · 조사만 골라 모아요. 내가 승인한 것만 팀과 나누고, 결정이 엇갈리면 먼저 알려드려요.
            </p>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row">
              <Link href={START.href} className={heroPrimary}>
                {START.label} <span aria-hidden>→</span>
              </Link>
              <Link href="/install" className={heroOutline} style={{ background: "rgb(255 255 255 / 0.55)" }}>
                확장 설치 <span aria-hidden>↓</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <p className="text-[13px] text-ink-3">
            <span className="label-mono text-[11px]">What SyncUp does</span> · 누르면 바로 그 부분으로 이동해요
          </p>
          <RollSteps steps={STEPS} />
        </div>
        <p className="flex items-center gap-2 text-[13px] text-ink-3">
          아래로 내리면 기능을 하나씩 보여드려요 <ChevronDown className="size-4" aria-hidden />
        </p>
      </div>
    </section>
  );
}

type Step = { label?: string; index?: number; sub: string };

// 단계 옆 원소 표기 (별의 일생: 수소 → 헬륨 → 탄소 → 철 → 초신성)
const ELEMENT = ["", "H → He", "He → C", "Fe", "✦"];

function StepLine({ step }: { step: Step }) {
  return (
    <p className="flex flex-wrap items-center gap-3 text-[12px]">
      <span className="label-mono text-ink">{step.label ?? `0${step.index} / 04`}</span>
      {step.index && (
        <span aria-hidden className="flex gap-1">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={cn("h-[3px] w-6", i === step.index ? "bg-ink" : "bg-blush-deep")} />
          ))}
        </span>
      )}
      {step.index && <span className="font-serif text-[15px] text-ink-2 italic">{ELEMENT[step.index]}</span>}
      <span className="button-mono text-ink-3">{step.sub}</span>
    </p>
  );
}

// 기능 섹션 (피그마 Section 0~4): 위 구분선 · 넓은 화면 높이 760 · 왼쪽 글 472 + 오른쪽 미리보기 560
function Feature({ id, en, step, title, body, bodyWidth, preview, cta }: {
  id: string;
  en: string; // 영어 큰 제목 (Inter Tight 800)
  step: Step;
  title: React.ReactNode;
  body: React.ReactNode;
  bodyWidth?: string;
  preview: React.ReactNode;
  cta?: boolean;
}) {
  return (
    <section id={id} className="scroll-mt-16 border-t border-ink">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-12 px-gutter py-16 sm:px-10 lg:min-h-[760px] lg:flex-row lg:items-center lg:px-20 lg:py-0">
        <div className="lg:w-[472px] lg:shrink-0">
          <StepLine step={step} />
          <h2 className="mt-6">
            <span className="title-display block text-[clamp(36px,4.6vw,58px)] text-ink">{en}</span>
            <span className="mt-4 block text-xl leading-[1.4] font-bold break-keep text-ink sm:text-2xl">{title}</span>
          </h2>
          <p className={cn("mt-5 text-base leading-[1.7] text-ink-body break-keep sm:text-[17px]", bodyWidth)}>{body}</p>
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

// 이렇게 사용해요: 수채화 배경 · 6단계 각진 번호 + 이어지는 선 · 단계마다 태그(강조 = 진갈색, 나머지 = 연분홍)
function HowTo() {
  return (
    <section id="how" className="relative scroll-mt-16 overflow-hidden border-t border-ink">
      <WatercolorBg />
      <div className="relative mx-auto max-w-[1280px] space-y-10 px-gutter py-16 sm:px-10 lg:px-20 lg:py-24">
        <h2>
          <span className="title-display block text-[clamp(36px,4.6vw,58px)] text-ink">How it works.</span>
          <span className="mt-3 block text-xl font-bold text-ink sm:text-2xl">이렇게 사용해요</span>
        </h2>
        <ol className="grid gap-8 sm:grid-cols-3 lg:grid-cols-6 lg:gap-0">
          {HOW.map((s, i) => (
            <li key={s.title} className="flex flex-col items-start gap-3 lg:pr-2">
              <span className="flex w-full items-center gap-2">
                <span className="flex size-8 shrink-0 items-center justify-center border border-ink bg-glass font-mono text-xs text-ink">{String(i + 1).padStart(2, "0")}</span>
                {i < HOW.length - 1 && <span aria-hidden className="hidden h-px flex-1 bg-ink lg:block" />}
              </span>
              <span className="text-[15px] font-bold text-ink">{s.title}</span>
              <span className="max-w-[172px] text-[13px] text-ink-body break-keep">{s.body}</span>
              <span className={cn("px-2 py-[3px] text-[11px] font-medium", s.strong ? "bg-ink text-white" : "bg-blush text-ink")}>{s.tag}</span>
              {s.link && (
                <Link href="/install" className="text-xs font-medium hover:underline">
                  설치 방법 보기 →
                </Link>
              )}
            </li>
          ))}
        </ol>
        <p className="text-[13px] text-ink-3">지금은 ChatGPT 웹을 지원해요. Claude와 Gemini는 준비 중이에요.</p>
      </div>
    </section>
  );
}

// Section 5 · 브라우저 확장 설치 (248:2)
function Install() {
  const version = release.version.split(".").slice(0, 2).join(".");
  return (
    <section id="install" className="scroll-mt-16 border-t border-ink">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-16 px-gutter py-16 sm:px-10 lg:flex-row lg:items-center lg:px-20 lg:py-24">
        <div className="lg:w-[520px] lg:shrink-0">
          <p className="flex flex-wrap gap-2.5 text-[13px]">
            <span className="label-mono text-[12px] text-ink">Extension</span>
            <span className="button-mono text-[12px] text-ink-3">브라우저 확장 · Chrome 데스크톱 · macOS · Windows</span>
          </p>
          <h2 className="mt-6">
            <span className="title-display block text-[clamp(36px,4.6vw,58px)] text-ink">Ready in three steps.</span>
            <span className="mt-4 block text-xl font-bold text-ink sm:text-2xl">3단계면 준비 끝나요</span>
          </h2>
          <p className="mt-4 max-w-[480px] text-base text-ink-body break-keep sm:text-[17px]">
            설치는 한 번만 하면 돼요. 그다음부터는 ChatGPT에서 평소처럼 대화하면 돼요.
          </p>
          <ol className="mt-8 space-y-5">
            {INSTALL_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex size-8 shrink-0 items-center justify-center border border-ink bg-glass font-mono text-[13px] text-ink">{String(i + 1).padStart(2, "0")}</span>
                <span className="space-y-1">
                  <span className="block text-[17px] font-bold text-ink">{s.title}</span>
                  <span className="block max-w-[430px] text-sm text-ink-body break-keep">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex items-center gap-3">
            <Link href="/install" className={primaryLg}>
              <Download className="size-[18px]" aria-hidden />
              확장 프로그램 받기
            </Link>
            <span className="font-mono text-[13px] text-ink-3">v{version} · 무료</span>
          </div>
          <p className="mt-5 text-[13px] text-ink-3">휴대폰에서는 설치할 수 없어요</p>
        </div>
        <div className="flex min-w-0 flex-1 justify-center">
          <PopupPreview />
        </div>
      </div>
    </section>
  );
}
