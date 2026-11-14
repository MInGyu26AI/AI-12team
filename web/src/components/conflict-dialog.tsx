"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { fmtMDHM, parseSource } from "@shared/format";
import { ALERT_LEVEL, alertLevel } from "@shared/labels";
import type { Conflict, RelatedCard, Resolution } from "@shared/types";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const DONE_MSG: Record<Resolution, string> = {
  "keep-existing": "기존 결정을 유지했어요",
  "adopt-new": "새 결정으로 변경했어요",
  "both-valid": "두 결정을 모두 유효하게 유지했어요",
  discuss: "팀에 논의를 요청했어요. 팀 결정 기록에 경고가 남아요",
};

// 피그마 5번: 결정 충돌 경고 (기존 유지 / 새 결정으로 변경 / 팀에 논의 요청)
export function ConflictDialog({
  conflicts,
  onClose,
  onResolved,
}: {
  conflicts: Conflict[];
  onClose: () => void;
  onResolved?: () => void; // 하나 처리할 때마다 (보드 목록 새로고침용)
}) {
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<string[]>([]);
  const [pending, setPending] = useState<Resolution | null>(null);
  const [note, setNote] = useState("");
  const [viewingExisting, setViewingExisting] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const left = conflicts.filter((c) => !done.includes(c.id));
  const position = Math.min(index, left.length - 1);
  const x = left[position];
  if (!x) return null;
  const isChange = x.judgement === "변경";
  const level = alertLevel(x);
  const tone = ALERT_LEVEL[level];

  const resolve = async (choice: Resolution) => {
    setPending(choice);
    try {
      await api.resolveConflict(x.id, choice, note.trim() || undefined);
      toast.success(DONE_MSG[choice]);
      setNote("");
      onResolved?.();
      if (left.length <= 1) onClose();
      else setDone((d) => [...d, x.id]);
    } catch (e) {
      toast.error(`처리 실패: ${(e as Error).message}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#2b2f3a]/80 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="conflict-title" className="relative max-h-[90dvh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-background p-6 shadow-xl sm:p-8">
        <button onClick={onClose} className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="닫기">
          <X className="size-5" />
        </button>

        <div className="flex items-start gap-4 pr-6">
          <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-full", tone.badge)}>
            <TriangleAlert className="size-6" />
          </span>
          <div className="space-y-1">
            <h2 id="conflict-title" className="text-xl font-bold break-keep sm:text-2xl">
              {isChange ? "기존 결정에서 변경되었습니다. 변경안으로 진행할까요?" : "기존 팀 결정과 충돌하는 내용이 있어요"}
            </h2>
            <p className="text-muted-foreground">
              주제: {x.topic_key} · 앞으로 적용할 결정을 선택해 주세요
              {left.length > 1 && <span className="ml-2 font-medium text-foreground">({position + 1}/{left.length})</span>}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {(!isChange || viewingExisting === x.id) && <Side label="기존 팀 결정" card={x.cardA} tone="old" />}
          <Side label="새로 올라온 결정" card={x.cardB} tone="new" />
        </div>

        <div className={cn("mt-4 rounded-lg p-4", tone.badge)}>
          <p className={cn("text-sm font-semibold", tone.text)}>
            {x.method === "rule" ? "규칙 참고" : "AI 판정"}: {x.judgement}
            {level === "review" && <span className="ml-2 rounded-full bg-background px-2 py-0.5 text-xs">확인 필요 · 확신도 낮음</span>}
            {x.resolution === "discuss" && <span className="ml-2 rounded-full bg-background px-2 py-0.5 text-xs text-foreground">논의 요청됨</span>}
          </p>
          <p className="mt-1 text-sm break-keep">{x.reason}</p>
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="처리 이유 (선택) 예: 시연 효과 때문에 확장을 MVP에 포함"
          aria-label="처리 이유"
          className="mt-4 h-10 w-full rounded-lg border px-3 text-sm outline-none focus:border-brand"
        />

        <ResolutionActions
          isChange={isChange}
          pending={pending}
          discussed={x.resolution === "discuss"}
          hasNext={left.length > 1}
          viewingExisting={viewingExisting === x.id}
          onNext={() => setIndex((i) => (i + 1) % left.length)}
          onToggleExisting={() => setViewingExisting(viewingExisting === x.id ? null : x.id)}
          onResolve={resolve}
        />
      </div>
    </div>
  );
}

// 열릴 때 대화상자에 포커스를 주고 닫히면 이전 요소로 돌려준다. Esc 로 닫고, Tab 은 대화상자 안에서만 돈다
function useDialogFocus(dialog: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, [dialog]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled])") ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog.current)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, onClose]);
}

// '변경' 판정은 예/아니오(+기존 안 확인), '충돌'은 새 결정·기존 유지·둘 다 유효·논의 요청
function ResolutionActions({ isChange, pending, discussed, hasNext, viewingExisting, onNext, onToggleExisting, onResolve }: {
  isChange: boolean;
  pending: Resolution | null;
  discussed: boolean; // 이미 논의 요청된 경고
  hasNext: boolean;
  viewingExisting: boolean;
  onNext: () => void;
  onToggleExisting: () => void;
  onResolve: (choice: Resolution) => void;
}) {
  const label = (choice: Resolution, text: string) => (pending === choice ? "처리 중…" : text);
  return (
    <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
      {hasNext && (
        <Button variant="ghost" className="h-11 sm:mr-auto" onClick={onNext}>
          다음 경고 보기
        </Button>
      )}
      {isChange && (
        <Button variant="outline" className="h-11 px-5" disabled={!!pending} aria-expanded={viewingExisting} onClick={onToggleExisting}>
          기존 안 확인하기
        </Button>
      )}
      <Button variant="outline" className="h-11 px-5" disabled={!!pending} onClick={() => onResolve("adopt-new")}>
        {label("adopt-new", isChange ? "예" : "새 결정으로 변경")}
      </Button>
      <Button variant="outline" className="h-11 px-5" disabled={!!pending} onClick={() => onResolve("keep-existing")}>
        {label("keep-existing", isChange ? "아니오" : "기존 유지")}
      </Button>
      {!isChange && (
        <Button variant="outline" className="h-11 px-5" disabled={!!pending} onClick={() => onResolve("both-valid")}>
          {label("both-valid", "둘 다 유효")}
        </Button>
      )}
      {!isChange && (
        <Button className="h-11 bg-brand px-5 hover:bg-brand-hover" disabled={!!pending || discussed} onClick={() => onResolve("discuss")}>
          {label("discuss", discussed ? "논의 요청됨" : "팀에 논의 요청")}
        </Button>
      )}
    </div>
  );
}

function Side({ label, card, tone }: { label: string; card: RelatedCard; tone: "old" | "new" }) {
  const src = parseSource(card.source);
  return (
    <div className={cn("space-y-3 rounded-xl border-2 p-5", tone === "old" ? "border-brand/80" : "border-sensitive/80")}>
      <span
        className={cn(
          "inline-block rounded-full px-2.5 py-1 text-xs font-semibold",
          tone === "old" ? "bg-brand-soft text-brand" : "bg-sensitive-soft text-sensitive",
        )}
      >
        {label}
      </span>
      <p className="text-xl font-bold break-keep">{card.content}</p>
      <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <Avatar name={card.owner} size="sm" />
        {[card.owner, src.at && fmtMDHM(src.at), src.label].filter(Boolean).join(" · ")}
      </p>
      <div className="rounded-lg bg-muted/70 p-3 text-sm">
        <p className="text-xs font-medium text-muted-foreground">근거 문장</p>
        <p className="mt-1 break-keep">“{card.sentence}”</p>
      </div>
    </div>
  );
}
