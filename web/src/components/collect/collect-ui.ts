// 대화 수집 화면(대시보드 안)이 같이 쓰는 모양. 선 색은 둘러싼 앱 틀(.app-shell)이 정하므로 여기서 정하지 않는다.
// 이 화면의 새 카드·버튼은 모서리 0, 버튼 높이 40 (시안)
import { buttonOutline, buttonPrimary, card } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

/** 카드: 모서리 0 · 안쪽 여백은 쓰는 곳에서 */
export const panel = cn(card, "rounded-none");
/** 카드 제목 (h2) */
export const panelTitle = "text-base leading-[1.5] font-bold";
/** 카드 안 구분선 (위쪽) */
export const rowLine = "border-t border-card-border";
export const btnPrimary = cn(buttonPrimary, "h-10 rounded-none py-0");
export const btnOutline = cn(buttonOutline, "h-10 rounded-none py-0");
