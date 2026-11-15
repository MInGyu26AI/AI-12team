"use client";

import { cn } from "@/lib/utils";

// 피그마 토글 40×22 (켜짐 = 브랜드 남색, 꺼짐 = 베이지 #D6C9B5, 손잡이 지름 18)
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[22px] w-10 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand" : "bg-[#d6c9b5]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-[18px] rounded-full bg-white transition-transform",
          checked && "translate-x-[18px]",
        )}
      />
    </button>
  );
}
