"use client";

import { useState, useSyncExternalStore } from "react";
import { BURST_PATH } from "@/components/ui/burst-icon";

// 첫 화면 4단계 "롤 링크": 왼쪽 큰 영어 단어(Approve·Alert·Resolve·Record), 마우스를 올리거나 키보드로 포커스하면
// 글자가 한 자씩 위로 굴러 바뀌고(RollWord inline style) 오른쪽 패널에 그 단계 아이콘·영어 한 줄·한국어 설명이 나온다.
// 각 줄은 원래처럼 아래 기능 소개(#approve 등)로 가는 링크다. 움직임 줄이기 설정이면 굴림 없이 색만 바뀐다
export interface RollStep {
  id: string; // 아래 기능 소개 구역 id
  no: string;
  word: string;
  line: string; // 영어 한 줄
  title: string; // 한국어 제목
  body: string; // 한국어 설명
}

// 단계 아이콘: 점 96 / 고리 118(테두리 20) / 이중 고리 136(테두리 24 + 안쪽 연분홍 12) / 초신성 136 — 히어로의 별 단계와 같은 모양
const RING: React.CSSProperties = { display: "block", borderRadius: "50%", borderStyle: "solid", borderColor: "var(--color-ink)" };

function StepIcon({ index }: { index: number }) {
  if (index === 0) return <span aria-hidden style={{ ...RING, width: 96, height: 96, borderWidth: 48 }} />;
  if (index === 1) return <span aria-hidden style={{ ...RING, width: 118, height: 118, borderWidth: 20 }} />;
  if (index === 2) return <span aria-hidden style={{ ...RING, width: 136, height: 136, borderWidth: 24, boxShadow: "inset 0 0 0 12px var(--color-blush-deep)" }} />;
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="size-[136px] text-ink">
      <path d={BURST_PATH} fill="currentColor" />
    </svg>
  );
}

// 글자마다 같은 글자 2개를 세로로 쌓은 칸. 굴린 상태(on)면 칸 안에서 -50% 굴러 아래 글자가 보인다 (글자마다 24ms 시차).
// 스타일은 globals.css 없이 inline 으로만 (클래스가 빠지면 두 글자가 나란히 보이던 버그)
const CELL: React.CSSProperties = { display: "inline-block", overflow: "hidden", height: "1.18em", lineHeight: 1.18, verticalAlign: "top" };
const GLYPH: React.CSSProperties = { display: "block", height: "1.18em", lineHeight: 1.18 };

function RollWord({ word, on, still }: { word: string; on: boolean; still: boolean }) {
  return (
    <span aria-hidden>
      {[...word].map((ch, i) => {
        const c = ch === " " ? " " : ch;
        return (
          <span key={i} style={CELL}>
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
        <StepIcon index={active} />
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
