"use client";

import { CalendarDays, Hash, User } from "lucide-react";
import type { RelatedCard } from "@shared/types";
import { CardBadges } from "@/components/card-badges";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  card: RelatedCard;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onContentChange: (content: string) => void;
}

export function CandidateCard({ card: c, checked, onCheckedChange, onContentChange }: Props) {
  const suggestion = c.tag === "none"; // 제안 → 공유 후보 아님, 체크 불가
  const id = `pick-${c.id}`;

  return (
    <article
      className={cn(
        "flex gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors",
        checked && "border-primary/60 ring-1 ring-primary/20",
        suggestion && "bg-muted/60 text-muted-foreground shadow-none",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={suggestion}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-1"
        aria-label="이 카드 선택"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardBadges card={c} />
          {suggestion && <span className="text-xs font-medium">공유 후보 아님</span>}
        </div>

        {suggestion ? (
          <p className="break-keep">{c.content}</p>
        ) : (
          <Textarea
            value={c.content}
            onChange={(e) => onContentChange(e.target.value)}
            rows={1}
            className="min-h-0 resize-y font-medium"
            aria-label="내용 수정"
          />
        )}

        <p className="text-sm text-muted-foreground break-keep">“{c.sentence}”</p>

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {c.topic_key && (
            <span className="flex items-center gap-0.5">
              <Hash className="size-3" />
              {c.topic_key}
              {c.is_new_topic && " (새 주제)"}
            </span>
          )}
          {(c.tag === "todo" || c.tag === "decision") && (
            <span className="flex items-center gap-0.5">
              <User className="size-3" />
              {c.tag === "todo" ? "담당" : "결정"} {c.owner ?? "미정"}
            </span>
          )}
          {c.tag === "todo" && (
            <span className="flex items-center gap-0.5">
              <CalendarDays className="size-3" />
              기한 {c.due ?? "미정"}
            </span>
          )}
          <span>{c.source}</span>
          <span>확신도 {Math.round(c.confidence * 100)}%</span>
        </div>
      </div>
    </article>
  );
}
