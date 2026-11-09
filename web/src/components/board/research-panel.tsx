import { BookOpen } from "lucide-react";
import { parseSource } from "@shared/format";
import type { RelatedCard } from "@shared/types";

// 오른쪽: 조사·참고 자료 (최신순)
export function ResearchPanel({ research }: { research: RelatedCard[] }) {
  return (
    <section className="rounded-xl border bg-card p-5" aria-label="조사">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <BookOpen className="size-4 text-tag-research" />
        조사·참고 <span className="rounded-full bg-tag-research-soft px-2 text-sm text-tag-research">{research.length}</span>
      </h2>
      <ul className="mt-3 space-y-3">
        {research.map((r) => (
          <li key={r.id} className="text-sm">
            <p className="break-keep">{r.content}</p>
            <p className="text-xs text-muted-foreground">
              {r.topic_key} · {parseSource(r.source).label}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
