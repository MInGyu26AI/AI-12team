"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { fmtDue } from "@shared/format";
import type { RelatedCard } from "@shared/types";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

// 할 일 ID 복사: 커밋 메시지·PR 제목에 "[SU-3]" 처럼 넣으면 팀 서버가 그 할 일과 연결한다 (docs/team-state.md)
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    toast.success(`${id} 복사됨 · 커밋 메시지나 PR 제목에 넣어 주세요`);
  } catch {
    toast.error("클립보드 복사에 실패했어요");
  }
}

// 오른쪽: 할 일 체크 (담당·기한). 레포의 syncup.json 에 ID(SU-n)가 있으면 배지와 'ID 복사' (ID는 서버가 붙인다)
export function TodoPanel({ todos, done, todoIds, onToggle }: {
  todos: RelatedCard[];
  done: Set<string>;
  todoIds: Map<string, string>; // 카드 id → SU-n
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <section className="rounded-xl border bg-card p-5" aria-label="할 일">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        할 일 <span className="rounded-full bg-tag-todo-soft px-2 text-sm text-tag-todo">{todos.length}</span>
      </h2>
      <ul className="mt-3 space-y-3">
        {todos.map((t) => {
          const suId = todoIds.get(t.id);
          return (
            <li key={t.id} className="flex gap-3">
              <Checkbox
                checked={done.has(t.id)}
                onCheckedChange={(v) => onToggle(t.id, v === true)}
                className="mt-0.5 size-5 data-checked:border-brand data-checked:bg-brand"
                aria-label={`${t.content} 완료`}
              />
              <div className="min-w-0 flex-1">
                <p className={cn("font-medium break-keep", done.has(t.id) && "text-muted-foreground")}>
                  {suId && <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{suId}</span>}
                  {t.content}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-tag-todo">
                  {t.owner ?? "담당 미정"} · 기한 {t.due ? fmtDue(t.due) : "미정"}
                  {suId && (
                    <button onClick={() => void copyId(suId)} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                      <Copy className="size-3" />
                      ID 복사
                    </button>
                  )}
                </p>
              </div>
            </li>
          );
        })}
        {!todos.length && <li className="text-sm text-muted-foreground">할 일이 없어요.</li>}
      </ul>
    </section>
  );
}
