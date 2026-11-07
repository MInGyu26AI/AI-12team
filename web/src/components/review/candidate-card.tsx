"use client";

import { useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { fmtDue, parseSource } from "@shared/format";
import { TAG_BORDER, TAG_COLOR, TAG_LABEL, statusBadges } from "@shared/labels";
import type { RelatedCard } from "@shared/types";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface Props {
  card: RelatedCard;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onContentChange: (content: string) => void;
  onDismiss: () => void; // 버리기 (확장에서 온 카드는 검토 대기에서도 지움)
}

// 피그마 4번 승인함 카드: 체크박스 · 표시 · 내용 · 이유/담당·기한/출처, 표시마다 테두리 색
export function CandidateCard({ card: c, checked, onCheckedChange, onContentChange, onDismiss }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.content);
  const id = `pick-${c.id}`;
  const meta = metaLine(c);

  return (
    <article
      className={cn(
        "group flex gap-4 rounded-xl border-2 bg-card p-5 transition-colors",
        checked ? TAG_BORDER[c.tag] : "border-transparent shadow-xs",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-1 size-5 data-checked:border-brand data-checked:bg-brand"
        aria-label="이 카드 선택"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TAG_COLOR[c.tag])}>{TAG_LABEL[c.tag]}</span>
          {statusBadges(c).map((b) => (
            <span key={b.label} className={cn("rounded-full px-2 py-0.5 text-xs font-medium", b.color)}>
              {b.label}
            </span>
          ))}
          <span className="ml-auto flex gap-1 opacity-70 group-hover:opacity-100">
            {!editing && (
              <button type="button" onClick={() => (setDraft(c.content), setEditing(true))} className="rounded-md p-1 hover:bg-muted" aria-label="내용 수정">
                <Pencil className="size-3.5" />
              </button>
            )}
            <button type="button" onClick={onDismiss} className="rounded-md p-1 hover:bg-muted" aria-label="이 카드 버리기" title="버리기">
              <X className="size-3.5" />
            </button>
          </span>
        </div>

        {editing ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onContentChange(draft.trim() || c.sentence);
              setEditing(false);
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
              className="h-10 flex-1 rounded-md border px-3 text-[15px] outline-none focus:border-brand"
              aria-label="내용 수정"
            />
            <button className="rounded-md bg-brand px-3 text-white" aria-label="수정 저장">
              <Check className="size-4" />
            </button>
          </form>
        ) : (
          <label htmlFor={id} className="block cursor-pointer text-[17px] font-semibold break-keep">
            {c.content}
          </label>
        )}

        {meta && <p className={cn("text-sm break-keep", c.tag === "todo" ? "font-semibold text-tag-todo" : "text-muted-foreground")}>{meta}</p>}
        <p className="text-xs text-muted-foreground/80 break-keep">“{c.sentence}”</p>
      </div>
    </article>
  );
}

function metaLine(c: RelatedCard) {
  if (c.tag === "todo") return `담당 ${c.owner ?? "미정"} · 기한 ${c.due ? fmtDue(c.due) : "미정"}`;
  if (c.tag === "decision") return c.reason ? `이유: ${c.reason}` : c.owner ? `결정 ${c.owner}` : null;
  if (c.tag === "research") return `출처: ${parseSource(c.source).label}`;
  return null;
}
