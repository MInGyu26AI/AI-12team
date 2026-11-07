import { CalendarDays, Hash, User } from "lucide-react";
import type { RelatedCard } from "@shared/types";
import { CardBadges } from "@/components/card-badges";
import { cn } from "@/lib/utils";

export function BoardCard({ card: c }: { card: RelatedCard }) {
  const isTodo = c.tag === "todo";
  return (
    <article className="space-y-2 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardBadges card={c} showSubtopic={false} />
        {c.topic_key && (
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <Hash className="size-3" />
            {c.topic_key}
          </span>
        )}
      </div>

      <p className="font-medium break-keep">{c.content}</p>

      {isTodo && (
        // 할 일은 담당자·기한을 크게
        <div className="flex flex-wrap gap-2 text-sm">
          <Chip icon={<User className="size-3.5" />} label="담당" value={c.owner} />
          <Chip icon={<CalendarDays className="size-3.5" />} label="기한" value={c.due} />
        </div>
      )}

      <p className="text-sm text-muted-foreground break-keep">“{c.sentence}”</p>
      <p className="text-xs text-muted-foreground">
        {[!isTodo && c.owner && `결정 ${c.owner}`, c.source].filter(Boolean).join(" · ")}
      </p>
    </article>
  );
}

function Chip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium",
        value ? "bg-tag-todo-soft text-tag-todo" : "bg-warn-soft text-warn",
      )}
    >
      {icon}
      {label} {value ?? "미정"}
    </span>
  );
}
