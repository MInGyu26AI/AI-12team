import Link from "next/link";
import { useId } from "react";

// 사각형 아이콘 (확정본 app/icon.svg 와 같은 path): 진갈색 둥근 사각형 + 흰 S(선) + 오른쪽 위 4각 별. 폰트 없이 path 로만 그린다. 사각형 색은 currentColor
export const ICON_S_PATH = "M 86.5 40.5 L 50.5 40.5 Q 40.5 40.5 40.5 50.5 L 40.5 50.0 Q 40.5 60.0 50.5 60.0 L 69.5 60.0 Q 79.5 60.0 79.5 70.0 L 79.5 69.5 Q 79.5 79.5 69.5 79.5 L 33.5 79.5";
export const SPARK_PATH = "M 99 4 C 100.428 16.92 103.08 19.572 116 21 C 103.08 22.428 100.428 25.08 99 38 C 97.572 25.08 94.92 22.428 82 21 C 94.92 19.572 97.572 16.92 99 4 Z";

export function LogoMark({ className = "size-10", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 120 120" aria-hidden className={`shrink-0 text-ink ${className}`} style={style}>
      <rect width="120" height="120" rx="14" fill="currentColor" />
      <path d={ICON_S_PATH} fill="none" stroke="#ffffff" strokeWidth="14" strokeLinejoin="round" />
      <path d={SPARK_PATH} fill="#ffffff" />
    </svg>
  );
}

// 확정 글씨 로고 (public/brand/syncup-wordmark.svg 와 같은 path, viewBox -62 -46 584 216). 폰트 없이 path 로만 그리고 색은 currentColor.
// 궤도가 글자를 가로지르는 틈은 <mask> 로 글자를 잘라낸 것이라 어떤 배경 위에서도 배경이 비친다. mask id 는 useId 로 로고마다 따로
export function Wordmark({ className = "", title = "SyncUp" }: { className?: string; title?: string | null }) {
  const cut = `syncup-cut-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox="-62 -46 584 216" className={className} {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}>
      <defs>
      <mask id={cut} maskUnits="userSpaceOnUse" x="-62" y="-46" width="584" height="216">
      <rect x="-62" y="-46" width="584" height="216" fill="#fff"/>
      <path d="M -26 112 C -70 156, 200 164, 360 146 C 452 136, 494 84, 498 -20" fill="none" stroke="#000" strokeWidth="18" strokeLinecap="round"/></mask>
      </defs>
      <g mask={`url(#${cut})`}>
      <path d="M 72.0 10.0 L 22.0 10.0 Q 10.0 10.0 10.0 22.0 L 10.0 38.0 Q 10.0 50.0 22.0 50.0 L 50.0 50.0 Q 62.0 50.0 62.0 62.0 L 62.0 78.0 Q 62.0 90.0 50.0 90.0 L 0.0 90.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" />
      <path d="M 96.0 40.0 L 96.0 64.0 Q 96.0 76.0 108.0 76.0 L 148.0 76.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" />
      <path d="M 138.0 40.0 L 138.0 110.0 Q 138.0 122.0 126.0 122.0 L 86.0 122.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" />
      <path d="M 172.0 100.0 L 172.0 52.0 Q 172.0 40.0 184.0 40.0 L 202.0 40.0 Q 214.0 40.0 214.0 52.0 L 214.0 100.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" />
      <path d="M 296.0 40.0 L 260.0 40.0 Q 248.0 40.0 248.0 52.0 L 248.0 78.0 Q 248.0 90.0 260.0 90.0 L 296.0 90.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" />
      <path d="M 320.0 0.0 L 320.0 78.0 Q 320.0 90.0 332.0 90.0 L 360.0 90.0 Q 372.0 90.0 372.0 78.0 L 372.0 0.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" />
      <path d="M 406.0 132.0 L 406.0 52.0 Q 406.0 40.0 418.0 40.0 L 436.0 40.0 Q 448.0 40.0 448.0 52.0 L 448.0 78.0 Q 448.0 90.0 436.0 90.0 L 396.0 90.0" fill="none" stroke="currentColor" strokeWidth="20" strokeLinejoin="round" /></g>
      <path d="M -40 21 C -39.244 27.84 -37.84 29.244 -31 30 C -37.84 30.756 -39.244 32.16 -40 39 C -40.756 32.16 -42.16 30.756 -49 30 C -42.16 29.244 -40.756 27.84 -40 21 Z" fill="currentColor"/>
      <path d="M -26 112 C -70 156, 200 164, 360 146 C 452 136, 494 84, 498 -20" fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round"/>
      <path d="M 498 -40 C 499.68 -24.8 502.8 -21.68 518 -20 C 502.8 -18.32 499.68 -15.2 498 0 C 496.32 -15.2 493.2 -18.32 478 -20 C 493.2 -21.68 496.32 -24.8 498 -40 Z" fill="currentColor"/>
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex shrink-0 items-center gap-2.5 text-ink">
      <LogoMark />
      <span className="flex flex-col gap-1">
        <Wordmark className="-my-[6px] -ml-[10px] h-[34px] w-[92px] self-start" />
        <span className="label-mono hidden text-[9.5px] leading-[1.2] text-ink-3 sm:block">Shared Memory for Students</span>
      </span>
    </Link>
  );
}
