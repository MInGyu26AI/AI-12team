"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

// 대화 수집 화면의 밑줄 탭 4개. 고른 탭은 주소의 ?tab= 에 두어 사이드바·다른 화면에서 바로 열 수 있다
export const COLLECT_TABS = [
  { id: "connection", label: "연결 상태" },
  { id: "settings", label: "수집 설정" },
  { id: "import", label: "직접 가져오기" },
  { id: "recent", label: "최근 수집" },
] as const;

export type CollectTab = (typeof COLLECT_TABS)[number]["id"];

export const DEFAULT_COLLECT_TAB: CollectTab = "connection";

/** ?tab= 값을 탭으로. 없거나 모르는 값이면 연결 상태 */
export const parseCollectTab = (value: string | null | undefined): CollectTab =>
  COLLECT_TABS.find((t) => t.id === value)?.id ?? DEFAULT_COLLECT_TAB;

const tabId = (tab: CollectTab) => `collect-tab-${tab}`;
const panelId = (tab: CollectTab) => `collect-panel-${tab}`;

// 탭 줄: 화살표·Home·End 로 옮기고 고른 탭만 Tab 키 순서에 둔다 (WAI-ARIA tabs 패턴)
export function CollectTabList({ value, onChange }: { value: CollectTab; onChange: (tab: CollectTab) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = COLLECT_TABS.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    onChange(COLLECT_TABS[next].id);
    buttons.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label="대화 수집" className="flex gap-x-6 border-b border-card-border">
      {COLLECT_TABS.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={selected}
            aria-controls={panelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "-mb-px h-10 cursor-pointer border-b-2 text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              selected ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// 탭 내용 자리. @container: 안쪽 격자가 화면이 아니라 이 칸의 너비를 보고 열 수를 정한다
export function CollectTabPanel({ tab, children }: { tab: CollectTab; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} className="@container">
      {children}
    </div>
  );
}
