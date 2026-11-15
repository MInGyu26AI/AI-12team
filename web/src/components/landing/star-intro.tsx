"use client";

import { useState } from "react";
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

// 상자 장식용 4각 별 (viewBox 0 0 100 100)
const STAR_PATH = "M50 0 C54 38 62 46 100 50 C62 54 54 62 50 100 C46 62 38 54 0 50 C38 46 46 38 50 0Z";

function Star({ size, outline, style }: { size: number; outline?: boolean; style: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="absolute text-ink" style={{ width: size, height: size, ...style }}>
      <path d={STAR_PATH} fill={outline ? "none" : "currentColor"} stroke={outline ? "currentColor" : "none"} strokeWidth={outline ? 6 : 0} />
    </svg>
  );
}

// 원 중심: 상자 높이의 42%
const center = "absolute top-[42%] left-1/2 -translate-x-1/2 -translate-y-1/2";

export function StarIntro() {
  const [run, setRun] = useState(0);
  return (
    <div className="relative overflow-hidden border-[3.5px] border-ink" style={{ background: "rgb(255 255 255 / 0.42)" }}>
      <div key={run} className="star-stage relative h-[420px] sm:h-[clamp(520px,62vw,640px)]">
        <Star size={40} style={{ top: 26, left: 30 }} />
        <Star size={18} outline style={{ top: 82, left: 84 }} />
        <Star size={30} style={{ bottom: 40, right: 46 }} />
        <p aria-hidden className="absolute top-7 right-8 font-mono text-[12px] tracking-[0.22em] text-ink-2">FROM CHAT TO DECISION</p>

        {/* 점·고리: 테두리 두께가 지름의 절반이면 꽉 찬 점, 줄이면 고리. 안쪽 inset 그림자가 이중 고리의 연분홍 칸 */}
        <div className={center}>
          <div
            data-anim
            style={{ animationName: "starCore", width: 34, height: 34, borderRadius: "50%", borderStyle: "solid", borderColor: "var(--color-ink)", borderWidth: 17, opacity: 0, boxSizing: "border-box" }}
          />
        </div>
        <svg viewBox="0 0 100 100" aria-hidden className={`${center} size-28 text-ink`}>
          <path d={BURST_PATH} fill="currentColor" data-anim style={{ animationName: "starBurst", transformOrigin: "50px 50px", opacity: 0 }} />
        </svg>
        <div aria-hidden data-anim style={{ animationName: "starFlash", opacity: 0 }} className="absolute inset-0 bg-ink" />

        {/* 단계 문구: 상자 가운데, 높이 72% 지점. 단계마다 8px 아래에서 올라오며 나타났다 사라진다 */}
        {STAGES.map((s) => (
          <div
            key={s.no}
            data-anim
            style={{ animationName: s.anim, opacity: 0 }}
            className="absolute top-[72%] left-1/2 w-[min(560px,90%)] -translate-x-1/2 space-y-2 text-center"
          >
            <p className="font-mono text-[13px] tracking-[0.22em] text-ink-2">
              STAGE {s.no} / 04 · {s.name}
            </p>
            <p className="font-display text-[28px] leading-tight font-bold tracking-[-0.04em] text-ink sm:text-[36px]">{s.line}</p>
          </div>
        ))}

        <div data-anim style={{ animationName: "starWordmark" }} className={`${center} w-[min(820px,92%)]`}>
          <BigWordmark
            className="w-full"
            orbitProps={{ strokeDasharray: 1400, strokeDashoffset: 0, style: { animationName: "starOrbit" }, ...({ "data-anim": "" } as object) }}
            sparkProps={{ style: { animationName: "starSpark", transformBox: "fill-box", transformOrigin: "center" }, ...({ "data-anim": "" } as object) }}
          />
          <p data-anim style={{ animationName: "starTagline" }} className="mt-2 text-center font-serif text-[clamp(22px,2.4vw,30px)] text-ink-body italic">
            Sync up the scattered. Think up what&apos;s next.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setRun((n) => n + 1)}
        className="absolute bottom-[26px] left-[30px] flex min-h-11 items-center gap-2 border border-ink px-4 font-mono text-[12px] tracking-[0.22em] text-ink hover:bg-white"
        style={{ background: "rgb(255 255 255 / 0.7)" }}
      >
        <span aria-hidden>↻</span> REPLAY
      </button>
    </div>
  );
}
