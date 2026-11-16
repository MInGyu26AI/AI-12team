"use client";

// 대시보드 위에 뜨는 팝업 틀 (PC 연결하기·이용 방법 슬라이드가 같이 쓴다).
// 창 크기와 상관없이 720×520 (창이 더 작으면 24px 여백을 남기고 줄어든다). 위 56px 머리 · 가운데 스크롤 본문 · 아래 72px 발.
// 포털을 쓰지 않고 그 자리에 그려서 .app-shell 의 글꼴·머리카락 선 규칙이 그대로 적용되게 한다 (globals.css).
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** 슬라이드 버튼 공통 모양. 기본(진갈색 채움)과 보조(흰 바탕 + 머리카락 선) */
const slideButton =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 text-sm whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40";
export const slidePrimary = cn(slideButton, "h-10 border-0 bg-ink px-5 font-medium text-white hover:bg-brand-hover");
export const slideSecondary = cn(slideButton, "h-10 border border-ink/16 bg-[#fffdfa] px-4 text-ink hover:bg-blush");
/** 슬라이드 안의 작은 보조 버튼 (이용 방법 슬라이드의 이동 버튼) */
export const slideSmall = cn(slideButton, "h-9 border border-ink/16 bg-[#fffdfa] px-4 text-[13px] text-ink hover:bg-blush");

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DialogFrame({
  open,
  onClose,
  title,
  counter,
  labelledBy,
  scrollKey,
  bodyClassName = "p-6",
  size = "default",
  children,
  footer,
}: {
  /** default: 슬라이드 팝업 720×520. large: 입력칸이 있는 팀 만들기 팝업 760×620 (창이 작으면 함께 줄어든다) */
  size?: "default" | "large";
  open: boolean;
  onClose: () => void;
  /** 머리줄 제목 (예: PC 연결하기) */
  title: string;
  /** 머리줄 제목 옆 작은 숫자 (예: 2 / 6) */
  counter?: string;
  /** 스크린리더가 창 이름으로 읽을 요소의 id (본문의 현재 슬라이드 제목) */
  labelledBy: string;
  /** 바뀌면 본문 스크롤을 맨 위로 되돌린다 (슬라이드를 넘길 때) */
  scrollKey?: string | number;
  bodyClassName?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 부모가 매번 새 onClose 를 넘겨도 아래 효과(포커스·스크롤 잠금)는 다시 돌지 않게 최신 값만 따로 들고 있는다
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    // 뒤 화면 스크롤 잠금: 스크롤바가 사라지며 화면이 밀리지 않게 그 폭만큼 오른쪽 여백을 대신 둔다
    const { overflow, paddingRight } = document.body.style;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [scrollKey]);

  if (!open) return null;

  // Tab 이 창 밖으로 나가지 않게 처음과 끝을 이어 준다
  const trapTab = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="app-shell fixed inset-0 z-50 flex items-center justify-center bg-[rgb(29_26_20/0.24)] p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          "flex h-full w-full flex-col border border-card-border bg-canvas text-ink shadow-[0_8px_24px_rgb(29_26_20/0.08)] outline-none",
          size === "large" ? "max-h-[620px] max-w-[760px]" : "max-h-[520px] max-w-[720px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-card-border pr-3 pl-6">
          <p className="text-sm font-medium text-ink">
            {title}
            {counter && <span className="ml-2 font-mono text-xs font-normal tabular-nums text-ink-3">{counter}</span>}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex size-10 cursor-pointer items-center justify-center text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
          >
            <X className="size-4" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
        <div ref={bodyRef} className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-auto", bodyClassName)}>
          {children}
        </div>
        {footer}
      </section>
    </div>
  );
}

/**
 * 슬라이드 아래 줄: 왼쪽 단계 표시(작은 막대, 눌러서 이동) · 오른쪽 이전 / 다음(마지막 장은 finishLabel).
 * 지나온 단계는 옅은 갈색, 지금 단계는 길고 진하게, 남은 단계는 가장 옅게 그린다.
 */
export function SlideFooter({
  labels,
  index,
  onIndex,
  onFinish,
  finishLabel,
}: {
  /** 단계마다 스크린리더 이름 (예: 이 PC 연결 3단계 …) */
  labels: string[];
  index: number;
  onIndex: (index: number) => void;
  onFinish: () => void;
  finishLabel: string;
}) {
  const last = labels.length - 1;
  return (
    <div className="flex h-[72px] shrink-0 items-center justify-between gap-3 border-t border-card-border px-6">
      <div className="flex gap-1">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => onIndex(i)}
            aria-label={label}
            aria-current={i === index ? "step" : undefined}
            className="flex size-6 cursor-pointer items-center justify-center outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
          >
            <span aria-hidden className={cn("h-1", i === index ? "w-4 bg-ink" : i < index ? "w-2 bg-ink/40" : "w-2 bg-ink/14")} />
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => onIndex(index - 1)} disabled={index === 0} className={slideSecondary}>
          이전
        </button>
        <button type="button" onClick={() => (index === last ? onFinish() : onIndex(index + 1))} className={slidePrimary}>
          {index === last ? finishLabel : "다음"}
        </button>
      </div>
    </div>
  );
}
