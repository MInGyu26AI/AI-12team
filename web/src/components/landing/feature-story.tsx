"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sentences } from "@/components/ui/sentences";

// 첫 화면 아래 기능 소개 5단계 (overview · approve · alert · conflict · record).
// 움직임 줄이기 설정이 꺼져 있으면 화면 폭과 상관없이 "슬라이드"로 보인다:
//   - 긴 래퍼(단계 수 × 단계당 스크롤 길이 + 무대 높이) 안에서 한 화면 높이 무대가 헤더 아래에 고정(sticky)된 채 스크롤이 진행되고,
//     스크롤 위치에 따라 무대 안의 단계가 바뀐다. 스크롤은 브라우저 기본 그대로다 (휠 가로채기·스냅 없음).
//   - 글이 먼저, 그림이 조금 늦게 따로 부드럽게 바뀐다 (opacity + translate 만, 한 가지 곡선).
//   - 넓은 화면(lg, 1024px 이상)은 글 왼쪽 · 그림 오른쪽, 좁은 화면은 무대 안에서 글 위 · 그림 아래.
// 움직임 줄이기 설정이면 예전 그대로 섹션을 위아래로 쌓아 보여 준다 (고정·움직임 없음).
// 두 모드의 차이는 전부 CSS 클래스(motion-safe:)라서, 서버가 그린 HTML 이 이미 슬라이드 배치이고 불러온 뒤 배치가 튀지 않는다.
// JS 는 "지금 어느 단계인지"(data-state)와 "화면이 낮을 때 줄이는 비율"(--fit, --fit-all)만 정한다.

export type StepMark = { index?: number }; // 단계 번호(01~04). 없으면(첫 장 한눈에 보기) 번호 줄을 그리지 않는다

export interface FeatureStep {
  id: string; // 바로가기(#approve 등)가 가리키는 id. 구역 시작 위치의 표지(sentinel)에 붙는다
  en: string; // 영어 큰 제목 (Inter Tight 800)
  step: StepMark;
  title: ReactNode;
  body: ReactNode;
  bodyWidth?: string;
  preview: ReactNode;
  cta?: ReactNode;
}

function StepLine({ step }: { step: StepMark }) {
  if (!step.index) return null;
  return (
    <p className="flex flex-wrap items-center gap-3 text-[12px]">
      <span className="label-mono text-ink">{`0${step.index} / 04`}</span>
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-[3px] w-6", i === step.index ? "bg-ink" : "bg-blush-deep")} />
        ))}
      </span>
    </p>
  );
}

// 슬라이드 모드 조건. 아래 클래스의 motion-safe: 와 같은 뜻이다
const STORY_QUERY = "(prefers-reduced-motion: no-preference)";
// 글·그림을 나란히 놓는 폭 (lg). 이보다 좁으면 무대 안에서 위아래로 놓고 둘을 한꺼번에 줄인다
const WIDE_QUERY = "(min-width: 1024px)";
// 무대가 고정되는 위치(px) = 헤더 높이. 클래스 top-16 · scroll-mt-16 과 같은 값
const STAGE_TOP = 64;
// 넓은 화면에서 글·그림이 무대(높이 100svh − 65px)보다 크면 위아래에 이만큼 남기고 줄인다
const FIT_GAP = 24;

// 긴 래퍼: 슬라이드 모드에서만 grid 한 칸(모든 구역이 같은 자리에 겹침) + 높이 = 무대 + 단계 수 × 단계당 스크롤 길이.
// --story-step(단계당 스크롤 길이) 90svh: 단계마다 화면 한 장 가까이 스크롤하면 다음 단계로 넘어간다. --story-n 은 단계 수(인라인)
const WRAP = [
  "group/story relative [--story-step:90svh]",
  "motion-safe:grid motion-safe:grid-cols-1 motion-safe:grid-rows-1",
  "motion-safe:h-[calc(100svh_-_65px_+_var(--story-step)_*_var(--story-n))]",
  "motion-safe:border-t motion-safe:border-ink",
].join(" ");

// 구역 시작 표지: 높이 0 의 빈 요소에 #id 를 둔다. 쌓는 모드에서는 구역 바로 앞에 놓여 예전처럼 구역 위로 이동하고,
// 슬라이드 모드에서는 래퍼 안 (i + 0.5) × 단계당 길이 지점에 놓여 그 단계의 스크롤 구간 한가운데로 이동한다 (구간 = i ~ i+1 단계 길이).
const SENTINEL = [
  "block h-0 scroll-mt-16",
  "motion-safe:absolute motion-safe:inset-x-0 motion-safe:top-[calc((var(--i)_+_0.5)_*_var(--story-step))]",
].join(" ");

// 구역(한 단계). 슬라이드 모드: 모든 구역이 같은 칸에서 헤더 아래에 고정(sticky), 높이 = 화면 − 헤더, 위 구분선은 래퍼가 대신 긋는다.
// 지금 단계가 아니면 눌러지지 않고(pointer-events), 퇴장이 끝난 뒤(450ms) visibility:hidden 이 되어 Tab 이동·화면 읽기 대상에서 빠진다.
// 넘치는 그림이 옆으로 삐져나와 가로 스크롤을 만들지 않게 무대 밖은 자른다
const SECTION = [
  "group/step border-t border-ink",
  "motion-safe:sticky motion-safe:top-16 motion-safe:col-start-1 motion-safe:row-start-1 motion-safe:self-start motion-safe:overflow-hidden",
  "motion-safe:h-[calc(100svh_-_65px)] motion-safe:border-t-0",
  "motion-safe:pointer-events-none motion-safe:invisible motion-safe:transition-[visibility] motion-safe:duration-0 motion-safe:delay-[450ms]",
  "motion-safe:data-[state=active]:pointer-events-auto motion-safe:data-[state=active]:visible motion-safe:data-[state=active]:delay-0",
  "motion-safe:group-data-[ready=false]/story:transition-none",
].join(" ");

// 구역 안쪽: 예전 Feature 의 안쪽 그대로(너비 1280 · 위아래 여백 · 760 높이). 슬라이드 모드에서는 무대 높이를 채우고 가운데 정렬.
// 좁은 화면 슬라이드는 여백을 줄이고, 글+그림이 무대보다 크면 둘을 한꺼번에 줄인다(--fit-all, 가운데 기준)
const INNER = [
  "mx-auto flex max-w-[1280px] flex-col gap-12 px-gutter py-16 sm:px-10 lg:min-h-[760px] lg:flex-row lg:items-center lg:px-20 lg:py-0",
  "motion-safe:h-full motion-safe:min-h-0 motion-safe:justify-center motion-safe:gap-6 motion-safe:py-6",
  "lg:motion-safe:min-h-0 lg:motion-safe:gap-12 lg:motion-safe:py-0",
  "motion-safe:origin-center motion-safe:scale-[var(--fit-all,1)]",
].join(" ");

// 글·그림 움직임 (곡선 하나 cubic-bezier(0.22,1,0.36,1), opacity + translate 만).
//  - 들어올 때: 글 520ms · 80ms 뒤 시작, 그림 600ms · 200ms 뒤 시작 (그림이 글보다 120ms 늦게) · 아래서 16px / 24px 올라옴
//  - 나갈 때: 둘 다 450ms · 바로 시작 · 지나온 단계는 위로(-), 아직 안 온 단계는 아래로(+) 비켜 선다
//  - --fit: 넓은 화면에서 글·그림이 무대보다 크면 JS 가 정하는 줄임 비율 (scale 속성이라 translate 와 겹치지 않는다)
const MOTION_BASE =
  "lg:motion-safe:origin-left motion-safe:scale-[var(--fit,1)] motion-safe:opacity-0 motion-safe:transition-[opacity,translate] motion-safe:duration-[450ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:group-data-[ready=false]/story:transition-none";
const TEXT_MOTION = [
  MOTION_BASE,
  "motion-safe:group-data-[state=past]/step:-translate-y-4 motion-safe:group-data-[state=next]/step:translate-y-4",
  "motion-safe:group-data-[state=active]/step:opacity-100 motion-safe:group-data-[state=active]/step:duration-[520ms] motion-safe:group-data-[state=active]/step:delay-[80ms]",
].join(" ");
const VISUAL_MOTION = [
  MOTION_BASE,
  "motion-safe:group-data-[state=past]/step:-translate-y-6 motion-safe:group-data-[state=next]/step:translate-y-6",
  "motion-safe:group-data-[state=active]/step:opacity-100 motion-safe:group-data-[state=active]/step:duration-[600ms] motion-safe:group-data-[state=active]/step:delay-[200ms]",
].join(" ");

export function FeatureStory({ steps }: { steps: FeatureStep[] }) {
  const [active, setActive] = useState(0);
  const [ready, setReady] = useState(false); // 처음 자리를 잡는 동안(다시 불러오기·#주소 이동)은 움직임 없이 바로 바꾼다
  const wrapRef = useRef<HTMLDivElement>(null);
  const sentinels = useRef<(HTMLElement | null)[]>([]);

  // 지금 단계 = 구역 시작 표지 중 고정 위치(헤더 아래)에 가장 가까운 것.
  // 표지가 단계 구간의 한가운데에 있으므로 구간 경계(= 이웃한 표지의 한가운데)에서 바뀌고, 바로가기로 이동하면 그 단계가 된다.
  // 래퍼 위쪽이면 첫 단계, 아래쪽이면 마지막 단계가 저절로 고른다. 표지 5개의 위치만 읽어 가벼우므로 스크롤마다 바로 계산한다
  // (requestAnimationFrame 에 맡기면 화면이 그려지지 않는 탭에서 계산이 멈춘 채 남는다. 같은 값이면 React 가 다시 그리지 않는다)
  useEffect(() => {
    const mq = window.matchMedia(STORY_QUERY);
    const update = () => {
      if (!mq.matches) return; // 쌓는 모드에서는 단계가 없다 (data-state 는 CSS 에 쓰이지 않는다)
      let best = 0;
      let bestGap = Infinity;
      sentinels.current.forEach((el, i) => {
        if (!el) return;
        const gap = Math.abs(el.getBoundingClientRect().top - STAGE_TOP);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      setActive(best);
    };
    update();
    const readyTimer = window.setTimeout(() => setReady(true), 120);
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    mq.addEventListener("change", update);
    return () => {
      window.clearTimeout(readyTimer);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      mq.removeEventListener("change", update);
    };
  }, []);

  // 화면이 낮아 글·그림이 무대보다 커지면 줄인다 (잘라 내지 않는다). 보통 크기에서는 1.
  //  - 넓은 화면: 나란히 놓인 글·그림을 각각 무대 높이(위아래 FIT_GAP 제외)에 맞춘다 (--fit)
  //  - 좁은 화면: 위아래로 놓인 글+그림 전체를 무대 높이에 맞춘다 (--fit-all)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const inners = Array.from(wrap.querySelectorAll<HTMLElement>("[data-inner]"));
    const fit = () => {
      const wide = window.matchMedia(WIDE_QUERY).matches;
      for (const inner of inners) {
        const stage = inner.closest("section")?.clientHeight ?? 0;
        const parts = Array.from(inner.querySelectorAll<HTMLElement>(":scope > [data-fit]"));
        if (wide) {
          inner.style.setProperty("--fit-all", "1");
          for (const el of parts) {
            const room = stage - FIT_GAP * 2;
            const own = el.offsetHeight; // 변형(scale)은 포함하지 않는 원래 높이
            el.style.setProperty("--fit", room > 0 && own > room ? String(room / own) : "1");
          }
        } else {
          parts.forEach((el) => el.style.setProperty("--fit", "1"));
          const style = getComputedStyle(inner);
          const own = parts.reduce((sum, el) => sum + el.offsetHeight, 0)
            + (parseFloat(style.rowGap) || 0) * Math.max(0, parts.length - 1)
            + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
          inner.style.setProperty("--fit-all", stage > 0 && own > stage ? String(stage / own) : "1");
        }
      }
    };
    // 처음 한 번과 창 크기가 바뀔 때도 바로 잰다 (ResizeObserver 는 화면을 그릴 때만 알려 주므로 그것만 믿지 않는다)
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);
    wrap.querySelectorAll("[data-fit]").forEach((el) => observer.observe(el));
    window.addEventListener("resize", fit);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, []);

  // 표지(#id)와 구역을 한 쌍으로 이어 둔다: 쌓는 모드에서 표지가 구역 바로 앞에 와야 바로가기가 예전처럼 구역 위로 간다
  return (
    <div ref={wrapRef} data-ready={ready} className={WRAP} style={{ "--story-n": steps.length } as CSSProperties}>
      {steps.map((s, i) => (
        <Fragment key={s.id}>
          <div
            id={s.id}
            ref={(el) => {
              sentinels.current[i] = el;
            }}
            className={SENTINEL}
            style={{ "--i": i } as CSSProperties}
          />
          <section data-state={i === active ? "active" : i < active ? "past" : "next"} className={SECTION}>
            <div data-inner className={INNER}>
              <div data-fit className={cn("lg:w-[472px] lg:shrink-0", TEXT_MOTION)}>
                <StepLine step={s.step} />
                <h2 className="mt-6 first:mt-0">
                  <span className="title-display block text-[clamp(36px,4.6vw,58px)] text-ink">{s.en}</span>
                  <span className="mt-4 block text-xl leading-[1.4] font-bold break-keep text-ink sm:text-2xl">{s.title}</span>
                </h2>
                <p className={cn("mt-5 text-base leading-[1.7] text-ink-body break-keep sm:text-[17px]", s.bodyWidth)}><Sentences>{s.body}</Sentences></p>
                {s.cta}
              </div>
              <div data-fit className={cn("min-w-0 lg:flex-1", VISUAL_MOTION)}>
                <div className="flex justify-center lg:justify-start">{s.preview}</div>
              </div>
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
