// 공통 모양 (카드·칩·버튼·입력창). 시안 "로즈 & 올리브 수채화": 진갈색 1.5px 테두리·모서리 0·반투명 흰 카드 (globals.css 토큰).
// 여러 화면이 같은 모양을 쓰므로 문자열로 모아 둔다 (shadcn Button 은 높이·여백이 피그마와 달라 화면 버튼에는 이 값을 쓴다)
import { cn } from "@/lib/utils";

/** 카드: 진갈색 1.5px 테두리 · 반투명 흰 바탕(뒤의 수채화가 살짝 비침). 안쪽 여백은 화면마다 다르다 */
export const card = "rounded-[12px] border border-card-border bg-card";

/** 칩(알약): 글자 12px 보통 굵기 · 위아래 3 · 좌우 10 */
export const chip = "inline-flex items-center rounded-full px-2.5 py-[3px] text-xs leading-[1.5] font-medium whitespace-nowrap";

/** 버튼: 글자 14px · 모서리 8 · 좌우 18 · 위아래 10 (높이 41) */
const button =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-[18px] py-2.5 text-sm leading-[1.5] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
export const buttonPrimary = cn(button, "border border-ink bg-ink text-white hover:bg-brand-hover");
export const buttonOutline = cn(button, "border border-ink bg-glass text-foreground hover:bg-blush");
export const buttonSoft = cn(button, "bg-brand-soft text-foreground hover:bg-brand-soft/70");

/** 입력창: 높이 40 · 테두리 rgba(24,23,58,0.16) · 모서리 8 · 글자 14px (피그마 7-1) */
export const input =
  "h-10 w-full min-w-0 rounded-md border border-ink bg-white px-3 text-sm outline-none placeholder:text-text-tertiary focus:border-brand focus:ring-3 focus:ring-brand/15 read-only:bg-surface-soft disabled:bg-surface-soft disabled:text-muted-foreground";
