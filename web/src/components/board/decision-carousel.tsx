"use client";

import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { fmtMD, parseSource } from "@shared/format";
import { ALERT_LEVEL } from "@shared/labels";
import type { RelatedCard } from "@shared/types";
import { Segmented } from "@/components/segmented";
import { BurstIcon } from "@/components/ui/burst-icon";
import { buttonOutline } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import type { Flag } from "./decision-timeline";

// 팀 보드 "회전 보기": 결정 카드를 보이지 않는 원기둥 둘레에 세우고 한 장씩 돌린다 (프론트만, 데이터는 목록 보기와 같다).
// 카드 i 는 rotateY(i·360/n) translateZ(r), 링은 translateZ(-r) rotateY(-앞·360/n). 5초마다 다음 장, ←/→·PAUSE/PLAY·키보드 화살표.
// 충돌이 걸린 카드는 진갈색 바탕 + 흰 글씨로 뒤집고, 앞에 오면 아래 패널에서 기존 충돌 창을 연다

export const MAX_RING = 12; // 원기둥에는 최근 12장까지
const CARD_W = 400; // 카드 폭 (px)
const SLOT = 2 * 520 * Math.tan(Math.PI / 8); // 카드 한 칸 폭 (사이 간격 포함). 8장일 때 반지름이 520px 이 되게 맞춘 값
const MIN_R = 240; // 2~3장일 때 카드끼리 겹치지 않게
export const AUTO_MS = 5000;

/** 카드 수에 맞춘 원기둥 반지름(px). 한 칸 폭(SLOT)이 원 둘레의 1/n 이 되게: r = (SLOT/2) / tan(π/n). 0~1장은 0 */
export function ringRadius(n: number): number {
  if (n <= 1) return 0;
  return Math.max(MIN_R, Math.round(SLOT / 2 / Math.tan(Math.PI / n)));
}

/** 앞 카드 번호를 0..n-1 로 감는다 (← 를 눌러 -1 이 되면 마지막 장) */
export const wrapIndex = (i: number, n: number) => (n ? ((i % n) + n) % n : 0);

/** 카드 i 와 앞 카드 사이의 원 위 거리 (양쪽 중 가까운 쪽) */
export function ringDistance(i: number, front: number, n: number): number {
  const d = Math.abs(wrapIndex(i, n) - wrapIndex(front, n));
  return Math.min(d, n - d);
}

/** 거리별 흐림: 앞 1 · 1칸 .8 · 2칸 .45 · 3칸 이상 .18 */
export const ringOpacity = (distance: number) => (distance === 0 ? 1 : distance === 1 ? 0.8 : distance === 2 ? 0.45 : 0.18);

export type BoardView = "carousel" | "list";

/** "회전 보기 / 목록 보기" 전환 (기존 Segmented 재사용) */
export function BoardViewToggle({ value, onChange }: { value: BoardView; onChange: (v: BoardView) => void }) {
  return (
    <Segmented
      label="결정 보기 방식"
      value={value}
      onChange={onChange}
      options={[
        { value: "carousel", label: "회전 보기" },
        { value: "list", label: "목록 보기" },
      ]}
    />
  );
}

export function DecisionCarousel({ decisions, flagged, onOpenConflict }: {
  decisions: RelatedCard[]; // 목록 보기와 같은 카드 (최신순, 주제 필터 적용 뒤)
  flagged: Map<string, Flag>;
  onOpenConflict: () => void; // 기존 충돌 창 열기
}) {
  const cards = decisions.slice(0, MAX_RING);
  const n = cards.length;
  const [front, setFront] = useState(0);
  const [playing, setPlaying] = useState(true);
  const r = ringRadius(n);
  const step = n ? 360 / n : 0;
  const current = cards[wrapIndex(front, n)];
  const flag = current && flagged.get(current.id);

  // 주제를 바꿔 카드가 줄면 앞 카드를 첫 장으로
  const [shownCount, setShownCount] = useState(n);
  if (shownCount !== n) {
    setShownCount(n);
    setFront(0);
  }

  useEffect(() => {
    if (!playing || n < 2) return;
    const timer = setInterval(() => setFront((f) => f + 1), AUTO_MS);
    return () => clearInterval(timer);
  }, [playing, n]);

  const move = (by: number) => setFront((f) => f + by);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else return;
    e.preventDefault();
  };

  if (!n) return <p className="border bg-glass p-6 text-center text-sm text-muted-foreground">이 주제의 결정이 없어요.</p>;

  return (
    <section aria-label="결정 회전 보기" aria-roledescription="carousel" className="space-y-4">
      <div
        tabIndex={0}
        onKeyDown={onKey}
        className="relative h-[300px] overflow-hidden border bg-glass outline-offset-4"
        style={{ perspective: "1500px" }}
        aria-label="← → 로 넘겨요"
      >
        <div
          className="absolute inset-0"
          style={{
            transformStyle: "preserve-3d",
            transform: `translateZ(${-r}px) rotateY(${-front * step}deg)`,
            transition: "transform 1800ms cubic-bezier(.65,0,.25,1)",
          }}
        >
          {cards.map((c, i) => {
            const d = ringDistance(i, front, n);
            const f = flagged.get(c.id);
            return (
              <article
                key={c.id}
                aria-hidden={d !== 0}
                className={cn("absolute top-1/2 left-1/2 flex h-[220px] flex-col justify-between p-5", f ? "bg-ink text-white" : "bg-glass text-ink")}
                style={{
                  width: CARD_W,
                  marginLeft: -CARD_W / 2,
                  marginTop: -110,
                  border: `${d === 0 ? 2.5 : 1.5}px solid var(--color-ink)`,
                  opacity: ringOpacity(d),
                  backfaceVisibility: "hidden",
                  transform: `rotateY(${i * step}deg) translateZ(${r}px)`,
                  transition: "opacity 600ms",
                }}
              >
                <p className={cn("button-mono text-xs", f ? "text-flare" : "text-ink-3")}>
                  {c.topic_key ?? "기타"}
                  {f && ` · ${ALERT_LEVEL[f.level].label}`}
                </p>
                <p className="line-clamp-3 text-xl leading-snug font-bold break-keep">{c.content}</p>
                <p className={cn("text-sm", f ? "text-white/70" : "text-ink-2")}>{c.owner ?? "결정자 미정"}</p>
              </article>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonOutline} onClick={() => move(-1)} aria-label="이전 결정">
          <ChevronLeft />
        </button>
        <button type="button" className={buttonOutline} onClick={() => move(1)} aria-label="다음 결정">
          <ChevronRight />
        </button>
        <button type="button" className={cn(buttonOutline, "label-mono text-[11px]")} onClick={() => setPlaying((p) => !p)} aria-pressed={!playing}>
          {playing ? <Pause /> : <Play />}
          {playing ? "Pause" : "Play"}
        </button>
        <span className="ml-auto font-mono text-sm text-ink-3" aria-live="polite">
          {String(wrapIndex(front, n) + 1).padStart(2, "0")} / {String(n).padStart(2, "0")}
        </span>
      </div>

      {current && <FrontDetail card={current} flag={flag} onOpenConflict={onOpenConflict} />}
    </section>
  );
}

// 앞 카드 상세 (주제·내용·담당·날짜를 크게). 충돌이 걸렸으면 진갈색 띠 + 기존 충돌 창 버튼
function FrontDetail({ card, flag, onOpenConflict }: { card: RelatedCard; flag?: Flag; onOpenConflict: () => void }) {
  const src = parseSource(card.source);
  return (
    <div className="space-y-3 border bg-glass p-6">
      <p className="button-mono text-sm text-ink-3">{card.topic_key ?? "기타"}</p>
      <p className="text-2xl leading-snug font-bold break-keep sm:text-3xl">{card.content}</p>
      {card.reason && <p className="text-[15px] text-ink-body break-keep">이유: {card.reason}</p>}
      <p className="text-sm text-ink-2">{[card.owner, src.at && fmtMD(src.at), src.label].filter(Boolean).join(" · ")}</p>
      {flag && (
        <div role="note" className="flex flex-wrap items-center gap-3 bg-ink px-4 py-3 text-flare">
          <BurstIcon className="size-5" />
          <p className="min-w-0 flex-1 font-semibold break-keep">
            결정이 엇갈렸어요{flag.previous ? ` · 이전: ${flag.previous}` : ""}
          </p>
          <button type="button" onClick={onOpenConflict} className="button-mono bg-flare px-4 py-2 text-sm text-ink hover:bg-flare/85">
            확인하기
          </button>
        </div>
      )}
    </div>
  );
}

// 폰 너비(md 미만)이거나 움직임 줄이기 설정이면 회전 보기 대신 목록 보기만 쓴다
const LIST_ONLY_QUERIES = ["(max-width: 767.98px)", "(prefers-reduced-motion: reduce)"];
const subscribeListOnly = (onChange: () => void) => {
  const lists = LIST_ONLY_QUERIES.map((q) => window.matchMedia(q));
  lists.forEach((m) => m.addEventListener("change", onChange));
  return () => lists.forEach((m) => m.removeEventListener("change", onChange));
};
const readListOnly = () => LIST_ONLY_QUERIES.some((q) => window.matchMedia(q).matches);

export function useListOnly(): boolean {
  return useSyncExternalStore(subscribeListOnly, readListOnly, () => false);
}
