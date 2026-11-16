"use client";

import { useState, useSyncExternalStore } from "react";

// 첫 화면 4단계 "롤 링크": 왼쪽 큰 영어 단어(Approve·Alert·Resolve·Record), 마우스를 올리거나 키보드로 포커스하면
// 글자가 한 자씩 위로 굴러 바뀌고(RollWord inline style) 오른쪽 패널에 그 단계 그림·영어 한 줄·한국어 설명이 나온다.
// 각 줄은 원래처럼 아래 기능 소개(#approve 등)로 가는 링크다. 움직임 줄이기 설정이면 굴림 없이 색만 바뀐다
export interface RollStep {
  id: string; // 아래 기능 소개 구역 id
  no: string;
  word: string;
  line: string; // 영어 한 줄
  title: string; // 한국어 제목
  body: string; // 한국어 설명
}

// 단계 그림 (확정본 stage-01~04 svg, viewBox 0 0 200 200, 좌표 그대로): 01 Approve · 02 Alert · 03 Resolve · 04 Record
const STAGE_ART: ((className: string) => React.ReactNode)[] = [
  // stage-01-approve.svg
  (className: string) => (
    <svg className={className} viewBox="0 0 200 200" role="img" aria-label="흩어진 점 중 일부만 진한 그림">
      <circle cx="38" cy="58" r="7" fill="#c9bfb3"/><circle cx="98" cy="36" r="7" fill="#c9bfb3"/><circle cx="168" cy="66" r="7" fill="#c9bfb3"/><circle cx="44" cy="156" r="7" fill="#c9bfb3"/><circle cx="160" cy="166" r="7" fill="#c9bfb3"/>
      <rect x="56" y="70" width="104" height="82" fill="none" stroke="#1d1a14" strokeWidth="1.5" strokeDasharray="5 5"/>
      <circle cx="78" cy="94" r="10" fill="#1d1a14"/><circle cx="128" cy="88" r="10" fill="#1d1a14"/><circle cx="96" cy="132" r="10" fill="#1d1a14"/><circle cx="140" cy="128" r="10" fill="#1d1a14"/>
    </svg>
  ),
  // stage-02-alert.svg
  (className: string) => (
    <svg className={className} viewBox="0 0 200 200" role="img" aria-label="두 점이 궤도를 따라 와 가운데서 반짝이는 그림">
      <path d="M 28 156 Q 52 74 100 98" fill="none" stroke="#1d1a14" strokeWidth="3" strokeLinecap="round"/>
      <path d="M 172 156 Q 148 74 100 98" fill="none" stroke="#1d1a14" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="28" cy="156" r="11" fill="#1d1a14"/><circle cx="172" cy="156" r="11" fill="#1d1a14"/>
      <path d="M 100 74 C 101.68 89.2 104.8 92.32 120 94 C 104.8 95.68 101.68 98.8 100 114 C 98.32 98.8 95.2 95.68 80 94 C 95.2 92.32 98.32 89.2 100 74 Z" fill="#1d1a14"/>
    </svg>
  ),
  // stage-03-resolve.svg
  (className: string) => (
    <svg className={className} viewBox="0 0 200 200" role="img" aria-label="겹친 두 원이 하나의 진한 원이 된 그림">
      <circle cx="74" cy="100" r="36" fill="none" stroke="#a39a8e" strokeWidth="2" strokeDasharray="5 5"/>
      <circle cx="126" cy="100" r="36" fill="none" stroke="#a39a8e" strokeWidth="2" strokeDasharray="5 5"/>
      <path d="M 52 100 L 82 100 M 148 100 L 118 100" stroke="#1d1a14" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="100" cy="100" r="24" fill="#1d1a14"/>
    </svg>
  ),
  // stage-04-record.svg
  (className: string) => (
    <svg className={className} viewBox="0 0 200 200" role="img" aria-label="점이 궤도를 타고 올라가 4각 별이 된 그림">
      <path d="M 34 150 C 18 186, 112 196, 146 146 C 160 124, 166 98, 166 72" fill="none" stroke="#1d1a14" strokeWidth="4" strokeLinecap="round"/>
      <circle cx="34" cy="150" r="8" fill="#1d1a14"/>
      <path d="M 166 26 C 168.02 44.24 171.76 47.98 190 50 C 171.76 52.02 168.02 55.76 166 74 C 163.98 55.76 160.24 52.02 142 50 C 160.24 47.98 163.98 44.24 166 26 Z" fill="#1d1a14"/>
    </svg>
  ),
];

// 글자마다 같은 글자 2개를 세로로 쌓은 칸. 굴린 상태(on)면 칸 안에서 -50% 굴러 아래 글자가 보인다 (글자마다 24ms 시차).
// 스타일은 globals.css 없이 inline 으로만 (클래스가 빠지면 두 글자가 나란히 보이던 버그)
// 높이 1.28em 은 Inter Tight 의 A 꼭대기·p 꼬리까지 담는 값, margin-block -0.05em 으로 늘어난 만큼 행 높이를 되돌린다.
// 가로는 자르지 않는다(letter-spacing -0.05em 이라 칸이 글자보다 좁다): overflow 는 globals.css .roll-cell (clip 미지원이면 hidden)
const CELL: React.CSSProperties = { display: "inline-block", height: "1.28em", lineHeight: 1.28, marginBlock: "-0.05em", verticalAlign: "top" };
const GLYPH: React.CSSProperties = { display: "block", height: "1.28em", lineHeight: 1.28 };

function RollWord({ word, on, still }: { word: string; on: boolean; still: boolean }) {
  return (
    <span aria-hidden>
      {[...word].map((ch, i) => {
        const c = ch === " " ? " " : ch;
        return (
          <span key={i} className="roll-cell" style={CELL}>
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                ...(still ? {} : { transition: "transform 640ms cubic-bezier(.22,1.25,.36,1)", transitionDelay: `${i * 24}ms`, transform: on ? "translateY(-50%)" : "none" }),
              }}
            >
              <span style={GLYPH}>{c}</span>
              <span style={GLYPH}>{c}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

// 움직임 줄이기 설정이면 굴리지 않는다
const REDUCE = "(prefers-reduced-motion: reduce)";
function subscribeReduce(cb: () => void) {
  const m = window.matchMedia(REDUCE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
function useReducedMotion() {
  return useSyncExternalStore(subscribeReduce, () => window.matchMedia(REDUCE).matches, () => false);
}

export function RollSteps({ steps }: { steps: RollStep[] }) {
  const [active, setActive] = useState(0);
  const current = steps[active]!;
  const still = useReducedMotion();
  return (
    <div className="grid w-full gap-6 border-t border-ink pt-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-stretch">
      <ul className="divide-y divide-ink/80 border-b border-ink">
        {steps.map((s, i) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              aria-label={`${s.no} ${s.title}`}
              className={`roll-row relative flex items-end py-3 pr-10 transition-colors outline-offset-4 ${i === active ? "text-ink" : "text-faint"}`}
            >
              <span className="title-display text-[clamp(52px,6.4vw,92px)]">
                <RollWord word={s.word} on={i === active} still={still} />
              </span>
              <span className="absolute top-3 right-1 font-mono text-[15px]">{s.no}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="flex flex-col justify-between gap-6 border bg-glass p-6 sm:p-8" aria-live="polite">
        {/* 단계를 바꾸면 key 로 다시 그려 200ms 페이드 (globals.css .stage-art-fade, 움직임 줄이기면 바로) */}
        <div key={active} className="stage-art-fade">
          {STAGE_ART[active]!("block h-auto w-[160px] sm:w-[220px]")}
        </div>
        <div className="space-y-2">
          <p className="font-mono text-[12px] tracking-[0.22em] text-ink-3">
            NO. {current.no} · {current.word.toUpperCase()}
          </p>
          <p className="font-display text-[26px] leading-tight font-bold tracking-[-0.04em] text-ink sm:text-[32px]">{current.line}</p>
          <p className="text-[15px] text-ink-body break-keep">{current.body}</p>
        </div>
      </div>
    </div>
  );
}
