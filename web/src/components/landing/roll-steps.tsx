"use client";

import { useState } from "react";
import { BURST_PATH } from "@/components/ui/burst-icon";

// 첫 화면 4단계 "롤 링크": 왼쪽 큰 영어 단어(Approve·Alert·Resolve·Record), 마우스를 올리거나 키보드로 포커스하면
// 글자가 한 자씩 위로 굴러 바뀌고(globals.css .roll-char) 오른쪽 패널에 그 단계 아이콘·영어 한 줄·한국어 설명이 나온다.
// 각 줄은 원래처럼 아래 기능 소개(#approve 등)로 가는 링크다. 움직임 줄이기 설정이면 굴림 없이 색만 바뀐다
export interface RollStep {
  id: string; // 아래 기능 소개 구역 id
  no: string;
  word: string;
  line: string; // 영어 한 줄
  title: string; // 한국어 제목
  body: string; // 한국어 설명
}

// 단계 아이콘: 점 / 고리 / 이중 고리(안쪽 연분홍) / 초신성 — 첫 화면 히어로의 별 단계와 같은 모양
const RING: React.CSSProperties = { display: "block", width: 96, height: 96, borderRadius: "50%", borderStyle: "solid", borderColor: "var(--color-ink)" };

function StepIcon({ index }: { index: number }) {
  if (index === 0) return <span aria-hidden style={{ ...RING, width: 64, height: 64, borderWidth: 32 }} />;
  if (index === 1) return <span aria-hidden style={{ ...RING, borderWidth: 18 }} />;
  if (index === 2) return <span aria-hidden style={{ ...RING, borderWidth: 22, boxShadow: "inset 0 0 0 11px var(--color-blush-deep)" }} />;
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="size-24 text-ink">
      <path d={BURST_PATH} fill="currentColor" />
    </svg>
  );
}

// 글자마다 같은 글자 2개를 세로로 쌓은 칸. 올리면 칸 안에서 -50% 굴러 아래 글자가 보인다 (글자마다 24ms 시차)
function RollWord({ word }: { word: string }) {
  return (
    <span aria-hidden>
      {[...word].map((ch, i) => (
        <span key={i} className="roll-char">
          <span style={{ transitionDelay: `${i * 24}ms` }}>
            <span>{ch}</span>
            <span>{ch}</span>
          </span>
        </span>
      ))}
    </span>
  );
}

export function RollSteps({ steps }: { steps: RollStep[] }) {
  const [active, setActive] = useState(0);
  const current = steps[active]!;
  return (
    <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-stretch">
      <ul className="divide-y divide-ink/80 border-y border-ink">
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
                <RollWord word={s.word} />
              </span>
              <span className="absolute top-3 right-1 font-mono text-[15px]">{s.no}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="flex flex-col justify-between gap-6 border bg-glass p-6 sm:p-8" aria-live="polite">
        <StepIcon index={active} />
        <div className="space-y-2">
          <p className="label-mono text-[11px] text-ink-3">
            {current.no} · {current.word}
          </p>
          <p className="title-display text-3xl sm:text-4xl">{current.line}</p>
          <p className="font-medium text-ink">{current.title}</p>
          <p className="text-[15px] text-ink-2 break-keep">{current.body}</p>
        </div>
      </div>
    </div>
  );
}
