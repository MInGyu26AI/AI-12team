"use client";

import { fmtDue } from "@shared/format";
import type { RelatedCard } from "@shared/types";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

// 오른쪽: 할 일 체크 (담당·기한)
export function TodoPanel({ todos, done, onToggle }: { todos: RelatedCard[]; done: Set<string>; onToggle: (id: string, on: boolean) => void }) {
  return (
    <section className="rounded-xl border bg-card p-5" aria-label="할 일">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        할 일 <span className="rounded-full bg-tag-todo-soft px-2 text-sm text-tag-todo">{todos.length}</span>
      </h2>
      <ul className="mt-3 space-y-3">
        {todos.map((t) => (
          <li key={t.id} className="flex gap-3">
            <Checkbox
              checked={done.has(t.id)}
              onCheckedChange={(v) => onToggle(t.id, v === true)}
              className="mt-0.5 size-5 data-checked:border-brand data-checked:bg-brand"
              aria-label={`${t.content} 완료`}
            />
            <div className="min-w-0">
              <p className={cn("font-medium break-keep", done.has(t.id) && "text-muted-foreground")}>{t.content}</p>
              <p className="text-sm text-tag-todo">
                {t.owner ?? "담당 미정"} · 기한 {t.due ? fmtDue(t.due) : "미정"}
              </p>
            </div>
          </li>
        ))}
        {!todos.length && <li className="text-sm text-muted-foreground">할 일이 없어요.</li>}
      </ul>
    </section>
  );
}
