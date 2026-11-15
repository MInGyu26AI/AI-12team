import { parseSource } from "@shared/format";
import type { RelatedCard } from "@shared/types";
import { card, chip } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 오른쪽: 조사·참고 자료 (최신순). 피그마 6번에 없는 기존 패널이라 '할 일' 카드와 같은 모양으로 둔다
export function ResearchPanel({ research }: { research: RelatedCard[] }) {
  return (
    <section className={cn(card, "p-5")} aria-label="조사">
      <h2 className="flex items-center gap-2 text-lg leading-[1.5] font-bold">
        조사·참고 <span className={cn(chip, "bg-tag-research-soft text-tag-research")}>{research.length}</span>
      </h2>
      <ul className="mt-3 space-y-3">
        {research.map((r) => (
          <li key={r.id} className="space-y-0.5 leading-[1.5]">
            <p className="text-sm font-medium break-keep">{r.content}</p>
            <p className="text-xs text-text-tertiary">
              {r.topic_key} · {parseSource(r.source).label}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
