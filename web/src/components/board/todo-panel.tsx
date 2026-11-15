"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { fmtDue } from "@shared/format";
import type { RelatedCard } from "@shared/types";
import { Checkbox } from "@/components/ui/checkbox";
import { card, chip } from "@/components/ui/surface";
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

// 오른쪽: 할 일 체크 (담당·기한). 피그마 182:165: 제목 옆 개수 칩, 줄마다 체크 칸 20 · ID 칩(누르면 복사) · 제목 14 · 담당·기한 12.
// 레포의 syncup.json 에 ID(SU-n)가 있을 때만 ID 칩이 보인다 (ID는 서버가 붙인다)
export function TodoPanel({ todos, done, todoIds, onToggle }: {
  todos: RelatedCard[];
  done: Set<string>;
  todoIds: Map<string, string>; // 카드 id → SU-n
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <section className={cn(card, "p-5")} aria-label="할 일">
      <h2 className="flex items-center gap-2 text-lg leading-[1.5] font-bold">
        할 일 <span className={cn(chip, "bg-brand-soft text-muted-foreground")}>{todos.length}</span>
      </h2>
      <ul className="mt-3 space-y-3">
        {todos.map((t) => {
          const suId = todoIds.get(t.id);
          const isDone = done.has(t.id);
          return (
            <li key={t.id} className="flex gap-3">
              <Checkbox
                checked={isDone}
                onCheckedChange={(v) => onToggle(t.id, v === true)}
                className="mt-0.5 size-5 rounded-[5px] border-[1.5px] border-foreground/25 bg-white data-checked:border-brand data-checked:bg-brand"
                aria-label={`${t.content} 완료`}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className={cn("text-sm leading-[1.5] font-medium break-keep", isDone && "text-muted-foreground")}>
                  {suId && (
                    <button
                      type="button"
                      onClick={() => void copyId(suId)}
                      title="ID 복사 · 커밋 메시지나 PR 제목에 넣으면 이 할 일과 연결돼요"
                      className="mr-1.5 inline-flex translate-y-[-1px] items-center gap-[3px] rounded-[4px] bg-blush px-[5px] py-0.5 align-middle font-mono text-[11px] leading-none font-medium text-ink hover:bg-blush-deep"
                    >
                      {suId}
                      <Copy className="size-2.5" aria-hidden />
                    </button>
                  )}
                  {t.content}
                </p>
                <p className="text-xs leading-[1.5] text-text-tertiary">
                  {t.owner ?? "담당 미정"} · 기한 {t.due ? fmtDue(t.due) : "미정"}
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
