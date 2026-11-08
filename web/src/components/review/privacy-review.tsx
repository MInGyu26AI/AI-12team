"use client";

import { useState } from "react";
import { ChevronDown, EyeOff, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { PrivacyExcluded, PrivacyHold, PrivacyMessage } from "@shared/bridge";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const REASON: Record<string, string> = {
  model_unavailable: "로컬 검사 모델 연결 필요",
  model_timeout: "로컬 검사 응답 지연",
  model_error: "로컬 검사 실패",
  model_output: "로컬 검사 실패",
  model_unsure: "개인정보 판단 불확실",
  rule_model_conflict: "개인정보 추가 확인 필요",
  residual_personal: "개인정보 추가 확인 필요",
  personal: "개인 내용으로 제외",
  user_excluded: "내가 분석에서 제외",
};

// Unknown or outbound-check reasons get one neutral label; raw codes and model output are never shown.
export const reasonLabel = (reason?: string | null) => (reason && REASON[reason]) || "개인정보 검사 확인 필요";

const ROLE = { user: "사용자", assistant: "AI" } as const;
const DECISION = { allow: "분석 가능", hold: "확인 필요", exclude: "분석에서 제외" } as const;
const time = (seconds: number) => new Date(seconds * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

type Action = (method: "privacy.recheck" | "privacy.exclude", params: { id: string; teamId: string; messageId?: string }) => Promise<{ queued: boolean }>;
type Kind = "recheck" | "exclude";
// The server keeps a batch held with this reason until the worker decides again, so "pending" survives a reload.
const REQUESTED: Record<string, Kind> = { recheck_requested: "recheck", exclude_requested: "exclude" };

function Preview({ text }: { text: string }) {
  return text ? (
    <p className="whitespace-pre-wrap break-keep rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{text}</p>
  ) : (
    <p className="text-sm text-muted-foreground">보존 기간이 지나 로컬 원문을 비웠어요.</p>
  );
}

export function HeldBatches({ items, teamId, modelAvailable, onAction, onRefresh }: {
  items: PrivacyHold[];
  teamId: string;
  modelAvailable: boolean | null | undefined;
  onAction: Action;
  onRefresh: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [asked, setAsked] = useState<Record<string, Kind>>({});
  const [stillHeld, setStillHeld] = useState<Record<string, boolean>>({});
  const [finished, setFinished] = useState<Kind[]>([]);

  // A request is finished only when the batch left the list or came back with a new (non-requested) decision.
  // Settled while rendering, keyed by list content, so no effect re-renders and no toast is fired twice.
  const signature = items.map((i) => `${i.id}:${i.reason}:${i.decidedAt}`).join("|") + "#" + Object.keys(asked).join(",");
  const [settledFor, setSettledFor] = useState(signature);
  if (signature !== settledFor) {
    setSettledFor(signature);
    const current = new Map(items.map((i) => [i.id, i]));
    const settled = Object.keys(asked).filter((id) => !current.has(id) || !REQUESTED[current.get(id)!.reason]);
    if (settled.length) {
      setFinished((f) => [...settled.filter((id) => !current.has(id)).map((id) => asked[id]), ...f].slice(0, 3));
      setStillHeld((s) => ({ ...s, ...Object.fromEntries(settled.filter((id) => current.has(id)).map((id) => [id, true])) }));
      setAsked((a) => Object.fromEntries(Object.entries(a).filter(([id]) => !settled.includes(id))));
    }
  }

  const run = async (item: PrivacyHold, kind: Kind, messageId?: string) => {
    setBusy(item.id + (messageId ?? ""));
    try {
      await onAction(kind === "recheck" ? "privacy.recheck" : "privacy.exclude", { id: item.id, teamId, ...(messageId ? { messageId } : {}) });
      setAsked((a) => ({ ...a, [item.id]: kind }));
      setStillHeld((s) => ({ ...s, [item.id]: false }));
    } catch (error) {
      // e.g. already rechecked by the worker: show why and read the latest list instead of hiding the batch.
      toast.error((error as Error).message);
      await onRefresh();
    } finally {
      setBusy(null);
    }
  };

  const notices = finished.map((kind, i) => (
    <p key={i} role="status" className="rounded-xl border bg-muted/40 px-4 py-3 text-sm">
      {kind === "exclude" ? "제외를 반영했어요. 남은 발화는 승인 대기에서 확인하세요." : "다시 검사를 마쳤어요. 결과는 승인 대기나 제외됨에서 확인하세요."}
    </p>
  ));
  if (!items.length) return <div className="space-y-4">{notices}<EmptyState title="확인이 필요한 대화 묶음이 없어요" /></div>;
  return (
    <div className="space-y-4">
      {notices}
      {modelAvailable === false && (
        <p role="status" className="rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
          이 기기의 로컬 검사 모델에 연결할 수 없어요. 모델을 실행한 뒤 다시 검사하세요. 그전까지는 외부 AI로 보내지 않아요.
        </p>
      )}
      {items.map((item) => {
        const waiting = REQUESTED[item.reason] ? { kind: REQUESTED[item.reason] } : null;
        const disabled = !!waiting || busy !== null;
        const held = item.messages.filter((m) => m.decision !== "allow");
        return (
          <article key={item.id} className="space-y-3 rounded-xl border p-5" aria-busy={!!waiting}>
            <div className="flex flex-wrap items-center gap-2">
              <ShieldAlert className="size-4 text-amber-600" aria-hidden />
              <Badge variant="outline">{waiting ? "검사 대기 중" : reasonLabel(item.reason)}</Badge>
              <span className="text-xs text-muted-foreground">{time(item.decidedAt)} 판정 · 발화 {item.messages.length}개</span>
            </div>
            <p className="break-keep">현재 묶음은 외부 AI 분석 전 보류되어 있어요.</p>
            {waiting && (
              <p role="status" className="text-sm text-muted-foreground">
                {waiting.kind === "recheck" ? "다시 검사를 요청했어요. 결과를 기다리는 중…" : "제외를 요청했어요. 남은 발화를 다시 확인하는 중…"}
              </p>
            )}
            {!waiting && stillHeld[item.id] && (
              <p role="status" className="text-sm text-muted-foreground">다시 검사했지만 아직 확인이 필요해요.</p>
            )}
            <button
              className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
              aria-expanded={!!open[item.id]}
              onClick={() => setOpen((o) => ({ ...o, [item.id]: !o[item.id] }))}
            >
              발화 {item.messages.length}개 보기
              <ChevronDown className={cn("size-4 transition-transform", open[item.id] && "rotate-180")} aria-hidden />
            </button>
            {open[item.id] && (
              <ul className="space-y-3">
                <li className="text-xs text-muted-foreground">키·연락처 같은 형식만 가린 로컬 원문이에요. 개인 내용이 그대로 보일 수 있고, 이 화면에서만 보여요.</li>
                {item.messages.map((m: PrivacyMessage) => (
                  <li key={m.id} className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{ROLE[m.role] ?? m.role}</span>
                      <Badge variant={m.decision === "allow" ? "secondary" : "outline"}>{m.decision ? DECISION[m.decision] : "판정 없음"}</Badge>
                      {m.decision !== "allow" && <span className="text-muted-foreground">{reasonLabel(m.reason)}</span>}
                    </div>
                    <Preview text={m.text} />
                    {m.decision !== "allow" && (
                      <Button variant="outline" size="sm" disabled={disabled} onClick={() => run(item, "exclude", m.id)}>
                        이 발화 분석에서 제외
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={disabled} onClick={() => run(item, "recheck")}>
                {busy === item.id ? "요청 중…" : "다시 검사"}
              </Button>
              {held.length > 0 && (
                <Button variant="ghost" disabled={disabled} onClick={() => run(item, "exclude")}>
                  확인이 필요한 발화 {held.length}개 분석에서 제외
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function ExcludedMessages({ items, total }: { items: PrivacyExcluded[]; total: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!items.length) return <EmptyState title="분석에서 제외된 발화가 없어요" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground break-keep">분석에서 제외했으며 로컬 원문을 삭제한 것은 아니에요. 제외한 발화는 외부 AI와 팀에 보내지 않아요.</p>
      {total > items.length && <p className="text-xs text-muted-foreground">최근 {items.length}개만 보여요 · 전체 {total}개</p>}
      <ul className="space-y-3">
        {items.map((e) => {
          const key = e.jobId + ":" + e.messageId;
          return (
            <li key={key} className="space-y-2 rounded-xl border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <EyeOff className="size-4 text-muted-foreground" aria-hidden />
                <Badge variant="outline">{reasonLabel(e.reason)}</Badge>
                <span className="text-muted-foreground">
                  {[e.role ? ROLE[e.role] : null, e.site, time(e.decidedAt) + " 판정"].filter(Boolean).join(" · ")}
                </span>
              </div>
              <p className="text-sm">이 발화는 분석에서 제외됐어요.</p>
              <button
                className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
                aria-expanded={!!open[key]}
                onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
              >
                로컬 원문 보기
                <ChevronDown className={cn("size-4 transition-transform", open[key] && "rotate-180")} aria-hidden />
              </button>
              {open[key] && <Preview text={e.text} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PrivacyError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <ErrorState message={`개인정보 검사 목록을 새로 읽지 못했어요. 마지막으로 받은 목록을 보여 줘요. (${message})`} onRetry={onRetry} />;
}
