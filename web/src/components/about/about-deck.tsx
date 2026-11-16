"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { WatercolorBg } from "@/components/ui/watercolor-bg";
import { START } from "@/lib/start-link";
import { useSignedIn } from "@/lib/use-signed-in";
import { cn } from "@/lib/utils";
import { Sentences } from "@/components/ui/sentences";

const PROBLEMS = [
  { title: "팀원마다 다른 AI", body: "누구는 ChatGPT, 누구는 Claude·Gemini. 무료 AI를 섞어 쓰면 대화가 각자 계정에 흩어져요." },
  { title: "결정이 대화 속에 묻힘", body: "“서비스명은 이걸로 하자”, “내가 금요일까지 할게” 같은 말이 긴 AI 대화 사이에 묻혀 다시 찾기 어려워요." },
  { title: "모르는 사이 엇갈린 결정", body: "한 사람은 ‘확장은 나중에’, 다른 사람은 ‘확장도 MVP에’라고 정해도 아무도 눈치채지 못해요." },
];

const DIFFERENTIATORS = [
  { title: "결정 충돌 감지", tone: "bg-ink text-white", text: "text-white/80",
    body: "새로 올라온 결정을 같은 주제의 기존 결정과 비교해 같음·변경·충돌을 판정하고, 어긋나면 근거 문장과 함께 먼저 알려줘요." },
  { title: "본인 승인 후 공유", tone: "bg-blush text-ink", text: "text-ink-body",
    body: "AI가 고른 후보는 내 승인함에만 쌓여요. 내가 체크한 카드만 팀에 올라가고, 원본 대화 전체는 팀 서버로 가지 않아요." },
  { title: "설치 부담 없이 누구나", tone: "bg-ok-soft text-ink", text: "text-ink-body",
    body: "브라우저 확장 하나면 ChatGPT 대화를 10회마다 자동으로 모아요. 확장을 못 써도 대화 붙여넣기·내보내기 파일로 쓸 수 있어요." },
];

const KINDS = [
  { tag: "결정", chip: "bg-tag-decision-soft text-tag-decision", body: "팀이 확정·합의·변경한 내용 → 충돌 비교 대상" },
  { tag: "할 일", chip: "border border-ink text-tag-todo", body: "누군가 해야 할 작업 → 담당자·기한까지" },
  { tag: "조사", chip: "bg-tag-research-soft text-tag-research", body: "알게 된 사실·자료·외부 조건 → 참고 자료" },
  { tag: "개인", chip: "border border-dashed border-tag-personal text-ink-3", body: "프로젝트와 상관없는 내용 → 후보로 보여 주지 않고 팀에 올리지 않음" },
];

const PRIVACY = [
  "설정한 범위의 대화에서 AI가 팀과 관련된 내용만 고르고, 내가 승인한 것만 팀에 공유해요.",
  "전화번호·이메일·계좌·주민번호는 외부 AI로 보내기 전에 가려요.",
  "대화 원문은 내 기기에만 남고, 처리가 끝나고 7일 뒤 지워져요.",
  "수집 기간이 끝나면 자동으로 멈추고, 언제든 일시정지할 수 있어요.",
];

const h2 = "text-[clamp(24px,2.6vw,34px)] leading-[1.3] font-bold break-keep";
const primary = "inline-flex h-12 items-center gap-2 bg-ink px-6 text-[15px] text-white transition-colors hover:bg-ink-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function slides(signedIn: boolean): { label: string; body: ReactNode }[] {
  return [
    {
      label: "소개",
      body: (
        <div className="grid items-center gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
          <div>
            <p aria-hidden className="title-display text-[clamp(40px,5vw,68px)] text-ink">What is SyncUp.</p>
            <h1 className="mt-5 text-[clamp(24px,2.6vw,34px)] leading-[1.35] font-bold break-keep">
              흩어진 AI 대화 속 팀 결정을
              <br />
              하나의 기록으로
            </h1>
          </div>
          <div className="space-y-4 text-[clamp(15px,1.3vw,17px)] leading-[1.7] text-ink-body break-keep">
            <p>SyncUp은 무료 AI를 섞어 쓰는 대학생 해커톤·팀플 팀을 위한 공유 메모리예요.</p>
            <p>
              각자의 AI 대화에서 팀에 필요한 <b className="font-bold text-ink">결정·조사·할 일</b>을 골라, 내가 승인한 것만 팀과 나누고, 결정이
              어긋나면 먼저 알려줘요.
            </p>
          </div>
        </div>
      ),
    },
    {
      label: "문제",
      body: (
        <div className="space-y-8 lg:space-y-10">
          <h2 className={h2}>팀플에서 이런 일, 겪어 봤죠?</h2>
          <ol className="grid border-t border-ink md:grid-cols-3">
            {PROBLEMS.map(({ title, body }, i) => (
              <li key={title} className={cn("py-5 md:pt-6 md:pb-0", i > 0 && "border-t border-card-border md:border-t-0 md:border-l md:pl-7", i < 2 && "md:pr-7")}>
                <p className="font-mono text-[13px] text-ink-3">0{i + 1}</p>
                <h3 className="mt-2.5 text-[clamp(18px,1.6vw,21px)] font-bold">{title}</h3>
                <p className="mt-2.5 text-[15px] leading-[1.7] text-ink-body break-keep"><Sentences>{body}</Sentences></p>
              </li>
            ))}
          </ol>
        </div>
      ),
    },
    {
      label: "차별점",
      body: (
        <div className="space-y-8 lg:space-y-10">
          <h2 className={h2}>SyncUp은 이렇게 달라요</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {DIFFERENTIATORS.map(({ title, body, tone, text }) => (
              <div key={title} className={cn("p-6", tone)}>
                <h3 className="text-[clamp(19px,1.7vw,22px)] font-bold">{title}</h3>
                <p className={cn("mt-3 text-sm leading-[1.7] break-keep", text)}><Sentences>{body}</Sentences></p>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      label: "AI 분류",
      body: (
        <div className="grid items-center gap-8 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div>
            <h2 className={h2}>AI가 대화를<br className="hidden md:block" /> 이렇게 나눠요</h2>
            <p className="mt-5 text-sm leading-[1.7] text-ink-2 break-keep">
              <Sentences>{"AI가 추천만 한 내용이나 “~하면 어때?” 같은 제안은 결정으로 치지 않아요. 팀이 받아들였을 때만 결정이 돼요."}</Sentences>
            </p>
          </div>
          <dl className="border-t border-ink">
            {KINDS.map(({ tag, chip, body }) => (
              <div key={tag} className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-4 border-b border-card-border py-4 lg:grid-cols-[96px_minmax(0,1fr)]">
                <dt><span className={cn("inline-flex h-6 items-center px-2.5 text-xs font-bold", chip)}>{tag}</span></dt>
                <dd className={cn("text-[15px] break-keep lg:text-base", tag === "개인" && "text-ink-2")}>{body}</dd>
              </div>
            ))}
          </dl>
        </div>
      ),
    },
    {
      label: "개인정보",
      body: (
        <div className="space-y-7">
          <h2 className={h2}>개인정보는 이렇게 지켜요</h2>
          <ul className="grid gap-x-10 gap-y-3.5 text-[15px] leading-[1.65] text-ink-body md:grid-cols-2">
            {PRIVACY.map((line) => (
              <li key={line} className="flex gap-3 break-keep">
                <Check aria-hidden className="mt-1 size-4 shrink-0 text-ok" />
                <span><Sentences>{line}</Sentences></span>
              </li>
            ))}
          </ul>
        </div>
      ),
    },
    {
      label: "시작하기",
      body: (
        <div className="flex flex-col items-center gap-6 text-center">
          <p className="title-display text-[clamp(36px,4.4vw,60px)] text-ink">
            Sync up, <span className="font-serif font-normal italic">think up.</span>
          </p>
          <p className="text-[clamp(16px,1.4vw,18px)] text-ink-body break-keep">흩어진 대화가 모여 결정이 되고, 그 결정이 터져 다음 생각이 돼요.</p>
          <div className="flex flex-col gap-3 pt-2 sm:flex-row">
            {signedIn ? (
              <Link href="/dashboard" className={primary}>대시보드로 가기 <ArrowRight aria-hidden className="size-4" /></Link>
            ) : (
              <Link href={START.href} className={primary}>{START.label} <ArrowRight aria-hidden className="size-4" /></Link>
            )}
          </div>
          {signedIn && <p className="text-[13px] text-ink-3 break-keep">이용 방법은 대시보드 사이드바에서 다시 볼 수 있어요.</p>}
        </div>
      ),
    },
  ];
}

// 발표처럼 한 장씩 넘기는 건 넓은 화면(md 이상)에서만. 좁은 화면은 슬라이드를 위에서 아래로 차례로 보인다
const WIDE = "(min-width: 768px)";
function useWide() {
  return useSyncExternalStore(
    (change) => { const mq = window.matchMedia(WIDE); mq.addEventListener("change", change); return () => mq.removeEventListener("change", change); },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** 서비스 소개를 화면 한 장에 한 슬라이드씩 (← → 키 · 아래 진행 막대 · 이전/다음 버튼) */
export function AboutDeck() {
  const signedIn = !!useSignedIn();
  const deck = useWide();
  const list = slides(signedIn);
  const last = list.length - 1;
  const [index, setIndex] = useState(0);
  const go = useCallback((next: number) => setIndex(Math.max(0, Math.min(last, next))), [last]);

  useEffect(() => {
    if (!deck) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      const move = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[event.key];
      if (move) { event.preventDefault(); setIndex((i) => Math.max(0, Math.min(last, i + move))); }
      else if (event.key === "Home") { event.preventDefault(); setIndex(0); }
      else if (event.key === "End") { event.preventDefault(); setIndex(last); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, last]);

  return (
    <section aria-roledescription="슬라이드 모음" aria-label="서비스 소개" className="relative overflow-hidden">
      <WatercolorBg className="opacity-50" />
      <div className="relative mx-auto flex max-w-wide flex-col gap-4 px-gutter py-6 md:h-[calc(100svh-66px)] md:min-h-[540px] md:px-8 md:py-7">
        <div className={cn("min-h-0 flex-1", deck ? "relative" : "space-y-4")}>
          {list.map(({ label, body }, i) => {
            const shown = !deck || i === index;
            return (
              <article
                key={label}
                aria-roledescription="슬라이드"
                aria-label={`${i + 1} / ${list.length} ${label}`}
                inert={!shown}
                className={cn(
                  "flex flex-col border border-card-border bg-white/85 p-6 md:px-10 md:py-9 lg:px-14 lg:py-10",
                  // 나가는 장은 빨리 사라지고(0.2초) 들어오는 장은 그 뒤에 들어와(0.15초 뒤 0.45초) 두 장의 글자가 겹쳐 보이지 않게
                  deck && "absolute inset-0 transition-[opacity,translate] ease-out motion-reduce:transition-none",
                  deck && (shown ? "duration-450 delay-150" : "duration-200"),
                  deck && !shown && "pointer-events-none opacity-0",
                  deck && !shown && (i < index ? "-translate-x-6" : "translate-x-6"),
                )}
              >
                <p className="font-mono text-xs tracking-[0.18em] text-ink-3">
                  {String(i + 1).padStart(2, "0")} / {String(list.length).padStart(2, "0")} · {label}
                </p>
                <div className="flex min-h-0 flex-1 flex-col justify-center pt-6 md:pt-4">{body}</div>
              </article>
            );
          })}
        </div>

        {deck && (
          <nav aria-label="슬라이드 이동" className="flex items-center gap-5">
            <ol className="grid flex-1 grid-cols-6 gap-1.5">
              {list.map(({ label }, i) => (
                <li key={label}>
                  <button
                    type="button"
                    onClick={() => go(i)}
                    aria-current={i === index ? "step" : undefined}
                    className="group block w-full py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    <span aria-hidden className={cn("block h-[3px] transition-colors", i <= index ? "bg-ink" : "bg-ink/15 group-hover:bg-ink/35")} />
                    <span className={cn("mt-1.5 block truncate text-[11px]", i === index ? "font-medium text-ink" : "text-ink-3")}>{label}</span>
                  </button>
                </li>
              ))}
            </ol>
            <span aria-hidden className="hidden font-mono text-xs text-ink-3 lg:inline">← → 키로 넘겨요</span>
            <span className="flex gap-2">
              <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="이전 슬라이드"
                className="flex size-11 items-center justify-center border border-input bg-white transition-colors hover:bg-canvas disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                <ArrowLeft aria-hidden className="size-[18px]" />
              </button>
              <button type="button" onClick={() => go(index + 1)} disabled={index === last} aria-label="다음 슬라이드"
                className="flex size-11 items-center justify-center bg-ink text-white transition-colors hover:bg-ink-body disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                <ArrowRight aria-hidden className="size-[18px]" />
              </button>
            </span>
          </nav>
        )}
        {deck && <p aria-live="polite" className="sr-only">{`${index + 1} / ${list.length} ${list[index].label}`}</p>}
      </div>
    </section>
  );
}
