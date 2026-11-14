"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { fmtMDHM, parseSource } from "@shared/format";
import { ALERT_LEVEL, alertLevel, type AlertLevel } from "@shared/labels";
import type { Conflict, RelatedCard, Resolution } from "@shared/types";
import { Avatar } from "@/components/avatar";
import { buttonOutline, buttonPrimary, chip, input } from "@/components/ui/surface";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const DONE_MSG: Record<Resolution, string> = {
  "keep-existing": "기존 결정을 유지했어요",
  "adopt-new": "새 결정으로 변경했어요",
  "both-valid": "두 결정을 모두 유효하게 유지했어요",
  discuss: "팀에 논의를 요청했어요. 팀 결정 기록에 경고가 남아요",
};

// 피그마 5번: 결정 충돌 경고 (152:346 · 기존 유지 / 새 결정으로 변경 / 팀에 논의 요청).
// 피그마에 없는 기존 기능(둘 다 유효 · 다음 경고 · 처리 이유 · '변경' 판정의 예/아니오)은 같은 버튼·입력 모양으로 둔다.
// 단계 색은 '충돌 알림 3단계'(226:976): 빨강은 충돌에만, 확인 필요·변경은 점과 글자색으로만
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
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-brand/55 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        className="relative max-h-[90dvh] w-full max-w-[900px] space-y-5 overflow-y-auto rounded-2xl border bg-background p-5 shadow-card sm:p-7"
      >
        <button onClick={onClose} className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="닫기">
          <X className="size-5" />
        </button>

        <div className="flex items-center gap-3.5 pr-6">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-soft">
            <TriangleAlert className={cn("size-[22px]", tone.text)} />
          </span>
          <div className="min-w-0 space-y-0.5 leading-[1.5]">
            <h2 id="conflict-title" className="text-lg font-medium break-keep sm:text-[22px]">
              {isChange ? "기존 결정에서 변경되었습니다. 변경안으로 진행할까요?" : "기존 팀 결정과 충돌하는 내용이 있어요"}
            </h2>
            <p className="text-sm text-muted-foreground break-keep">
              주제: {x.topic_key} · 앞으로 적용할 결정을 선택해 주세요
              {left.length > 1 && <span className="ml-2 font-medium text-foreground">({position + 1}/{left.length})</span>}
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {(!isChange || viewingExisting === x.id) && <Side label="기존 팀 결정" card={x.cardA} tone="old" level={level} />}
          <Side label={isChange ? "바뀐 결정" : "새로 올라온 결정"} card={x.cardB} tone="new" level={level} />
        </div>

        <div className="space-y-1 rounded-md bg-surface-soft px-4 py-3 leading-[1.5]">
          <p className={cn("flex flex-wrap items-center gap-2 text-[13px] font-medium", tone.text)}>
            {x.method === "rule" ? "규칙 참고" : "AI 판정"}: {x.judgement}
            {level === "review" && <span className={cn(chip, "bg-white py-0 text-[11px]")}>확인 필요 · 확신도 낮음</span>}
            {x.resolution === "discuss" && <span className={cn(chip, "bg-white py-0 text-[11px] text-foreground")}>논의 요청됨</span>}
          </p>
          <p className="text-sm break-keep">{x.reason}</p>
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="처리 이유 (선택) 예: 시연 효과 때문에 확장을 MVP에 포함"
          aria-label="처리 이유"
          className={input}
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

// '변경' 판정은 예/아니오(+기존 안 확인), '충돌'은 피그마 순서(기존 유지 · 새 결정으로 변경 · 팀에 논의 요청)에 둘 다 유효를 더한다
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
    <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-end">
      {hasNext && (
        <button type="button" className={cn(buttonOutline, "border-transparent bg-transparent sm:mr-auto")} onClick={onNext}>
          다음 경고 보기
        </button>
      )}
      {isChange ? (
        <>
          <button type="button" className={buttonOutline} disabled={!!pending} aria-expanded={viewingExisting} onClick={onToggleExisting}>
            기존 안 확인하기
          </button>
          <button type="button" className={buttonOutline} disabled={!!pending} onClick={() => onResolve("keep-existing")}>
            {label("keep-existing", "아니오")}
          </button>
          <button type="button" className={buttonPrimary} disabled={!!pending} onClick={() => onResolve("adopt-new")}>
            {label("adopt-new", "예")}
          </button>
        </>
      ) : (
        <>
          <button type="button" className={buttonOutline} disabled={!!pending} onClick={() => onResolve("keep-existing")}>
            {label("keep-existing", "기존 유지")}
          </button>
          <button type="button" className={buttonOutline} disabled={!!pending} onClick={() => onResolve("adopt-new")}>
            {label("adopt-new", "새 결정으로 변경")}
          </button>
          <button type="button" className={buttonOutline} disabled={!!pending} onClick={() => onResolve("both-valid")}>
            {label("both-valid", "둘 다 유효")}
          </button>
          <button type="button" className={buttonPrimary} disabled={!!pending || discussed} onClick={() => onResolve("discuss")}>
            {label("discuss", discussed ? "논의 요청됨" : "팀에 논의 요청")}
          </button>
        </>
      )}
    </div>
  );
}

// 결정 카드 (피그마 152:357·152:368): 흰 면 · 2px 테두리 #e2d6c3 · 모서리 12.
// 새 결정의 이름표는 단계 색: 충돌 = 빨강 칩, 확인 필요 = 노랑 테두리 + 글자, 변경 = 파랑 테두리 + 글자 (226:976 '결정 확인 카드')
const NEW_TONE: Record<AlertLevel, { border: string; label: string }> = {
  conflict: { border: "border-card-border", label: "bg-alert-conflict-soft text-alert-conflict" },
  review: { border: "border-alert-review-dot/50", label: "bg-alert-review-soft text-alert-review" },
  change: { border: "border-alert-change/40", label: "bg-alert-change-soft text-alert-change" },
};

function Side({ label, card, tone, level }: { label: string; card: RelatedCard; tone: "old" | "new"; level: AlertLevel }) {
  const src = parseSource(card.source);
  return (
    <div className={cn("min-w-0 space-y-2.5 rounded-[12px] border-2 bg-white p-5", tone === "old" ? "border-card-border" : NEW_TONE[level].border)}>
      <span className={cn(chip, tone === "old" ? "bg-change-soft text-change" : NEW_TONE[level].label)}>{label}</span>
      <p className="text-lg leading-[1.5] font-medium break-keep sm:text-[22px]">{card.content}</p>
      <p className="flex flex-wrap items-center gap-2 text-[13px] leading-[1.5] font-medium text-muted-foreground">
        <Avatar name={card.owner} size="sm" className="size-6 text-[11px]" />
        {[card.owner, src.at && fmtMDHM(src.at), src.label].filter(Boolean).join(" · ")}
      </p>
      <div className="space-y-1 rounded-md bg-canvas px-3.5 py-2.5 leading-[1.5]">
        <p className="text-xs font-medium text-muted-foreground">근거 문장</p>
        <p className="text-sm break-keep">“{card.sentence}”</p>
      </div>
    </div>
  );
}
