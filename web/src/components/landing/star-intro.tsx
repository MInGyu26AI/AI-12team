"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { BigWordmark } from "@/components/brand";
import { BURST_PATH } from "@/components/ui/burst-icon";

// 첫 화면 히어로의 8초 "별의 일생" (시안 "로즈 & 올리브 수채화"). 점 → 고리 → 이중 고리 → 수축 → 초신성 → 로고.
// 시간표는 globals.css 의 star* keyframes (모두 같은 8초 위의 %). 각 요소의 기본 스타일은 '끝난 상태'라서
// 움직임 줄이기 설정(애니메이션 없음)에서는 마지막 로고 화면만 보인다. ↻ REPLAY 는 무대를 다시 그려 처음부터 재생한다

const STAGES = [
  { no: "01", name: "APPROVE", line: "Only what you approve.", anim: "starStage1" },
  { no: "02", name: "ALERT", line: "Clashes, flagged first.", anim: "starStage2" },
  { no: "03", name: "RESOLVE", line: "Side by side, settled.", anim: "starStage3" },
  { no: "04", name: "RECORD", line: "Burst into the record.", anim: "starStage4" },
];

const center = "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2";

export function StarIntro() {
  const [run, setRun] = useState(0);
  return (
    <div className="frame-heavy relative overflow-hidden bg-glass">
      <div key={run} className="star-stage relative h-[340px] sm:h-[420px]">
        {STAGES.map((s) => (
          <div key={s.no} data-anim style={{ animationName: s.anim, opacity: 0 }} className="absolute top-5 left-5 space-y-1.5 sm:top-6 sm:left-7">
            <p className="label-mono text-[11px] text-ink-3">
              Stage {s.no} / 04 · {s.name}
            </p>
            <p className="title-display text-2xl text-ink sm:text-3xl">{s.line}</p>
          </div>
        ))}

        {/* 점·고리: 테두리 두께가 지름의 절반이면 꽉 찬 점, 줄이면 고리. 안쪽 inset 그림자가 이중 고리의 연분홍 칸 */}
        <div className={center}>
          <div
            data-anim
            style={{ animationName: "starCore", width: 34, height: 34, borderRadius: "50%", borderStyle: "solid", borderColor: "var(--color-ink)", borderWidth: 17, opacity: 0, boxSizing: "border-box" }}
          />
        </div>
        <svg viewBox="0 0 100 100" aria-hidden className={`${center} size-24 text-ink`}>
          <path d={BURST_PATH} fill="currentColor" data-anim style={{ animationName: "starBurst", transformOrigin: "50px 50px", opacity: 0 }} />
        </svg>
        <div aria-hidden data-anim style={{ animationName: "starFlash", opacity: 0 }} className="absolute inset-0 bg-ink" />

        <div data-anim style={{ animationName: "starWordmark" }} className={`${center} w-[min(560px,86%)]`}>
          <BigWordmark
            className="w-full"
            orbitProps={{ strokeDasharray: 1400, strokeDashoffset: 0, style: { animationName: "starOrbit" }, ...({ "data-anim": "" } as object) }}
            sparkProps={{ style: { animationName: "starSpark", transformBox: "fill-box", transformOrigin: "center" }, ...({ "data-anim": "" } as object) }}
          />
          <p data-anim style={{ animationName: "starTagline" }} className="mt-1 text-center font-serif text-xl text-ink-body italic sm:text-2xl">
            One memory for every chat.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setRun((n) => n + 1)}
        className="label-mono absolute bottom-3 left-4 flex items-center gap-1.5 text-[11px] text-ink-2 hover:text-ink"
      >
        <RotateCcw className="size-3.5" aria-hidden /> Replay
      </button>
    </div>
  );
}
