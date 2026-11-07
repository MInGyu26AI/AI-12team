"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Conflict, RelatedCard } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type ConflictChoice } from "@/lib/api";

const quote = (c: RelatedCard) => `'${c.sentence.replace(/[.?!]+$/, "")}'`;

export function ConflictAlert({ conflicts, onResolved }: { conflicts: Conflict[]; onResolved: () => void }) {
  if (!conflicts.length) return null;
  return (
    <section className="space-y-4 rounded-xl border border-sensitive/40 bg-sensitive-soft/60 p-4" aria-label="충돌 경고">
      <h2 className="flex items-center gap-2 font-semibold text-sensitive">
        <TriangleAlert className="size-5" />
        결정 충돌 {conflicts.length}건 — 팀이 하나로 정해 주세요
      </h2>
      {conflicts.map((x) => (
        <ConflictItem key={x.id} conflict={x} onResolved={onResolved} />
      ))}
    </section>
  );
}

function ConflictItem({ conflict: x, onResolved }: { conflict: Conflict; onResolved: () => void }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<ConflictChoice | null>(null);

  const resolve = async (choice: ConflictChoice) => {
    setPending(choice);
    try {
      await api.resolveConflict(x.id, choice, note.trim() || undefined);
      toast.success(choice === "keep-existing" ? "앞의 결정을 유지했어요" : "새 결정으로 변경했어요");
      onResolved();
    } catch (e) {
      toast.error(`충돌 처리 실패: ${(e as Error).message}`);
      setPending(null);
    }
  };

  return (
    <div className="space-y-3 rounded-lg bg-background p-3 shadow-sm">
      <p className="text-sm font-medium break-keep">
        <span className="text-sensitive">{x.topic_key}</span>: {quote(x.cardA)} vs {quote(x.cardB)}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Side label="앞의 결정" card={x.cardA} />
        <Side label="새 결정" card={x.cardB} />
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="처리 이유 (선택) 예: 시연 효과 때문에 확장을 MVP에 포함"
        rows={2}
        className="bg-background text-sm"
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" disabled={!!pending} onClick={() => resolve("keep-existing")} className="sm:flex-1">
          {pending === "keep-existing" ? "처리 중…" : "앞의 결정 유지"}
        </Button>
        <Button disabled={!!pending} onClick={() => resolve("adopt-new")} className="sm:flex-1">
          {pending === "adopt-new" ? "처리 중…" : "새 결정으로 변경"}
        </Button>
      </div>
    </div>
  );
}

function Side({ label, card }: { label: string; card: RelatedCard }) {
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="font-medium">{card.content}</p>
      <p className="text-muted-foreground">“{card.sentence}”</p>
      <p className="text-xs text-muted-foreground">
        {[card.owner && `결정 ${card.owner}`, card.source].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}
