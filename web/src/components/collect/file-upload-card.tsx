"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, FileText, FileUp, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { mockClassify } from "@shared/classify";
import { DEMO_KNOWN_NAMES } from "@shared/mock";
import type { Utterance } from "@shared/utterance";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { boardTopicKeys, USE_MOCK } from "@/lib/api";
import { ACCEPT_EXTENSIONS, MAX_FILE_BYTES, SUPPORTED_LABEL, unsupportedReason } from "@/lib/file-import/detect";
import { toMockUtterances } from "@/lib/file-import/mock";
import { createOcr } from "@/lib/file-import/ocr";
import { MAX_PDF_PAGES } from "@/lib/file-import/pdf";
import { sendFileMessages } from "@/lib/file-import/send";
import { groupUnread } from "@/lib/file-import/unread";
import { uploadFile, type UploadOutcome, type UploadPhase } from "@/lib/file-import/upload";
import { useCollectorStatus } from "@/lib/local-collector";
import { useMockCandidates } from "@/lib/mock-candidates";
import { ExtensionMissing } from "@/lib/rpc";
import { knownNamesOf, useTeam } from "@/lib/team";
import { cn } from "@/lib/utils";

// 자료 올리기: 회의록·기획서 같은 파일을 이 브라우저에서 읽어(글자가 없는 PDF 쪽은 이 PC의 AI가 글자 인식) 로컬 수집기로 보낸다.
// 파일 자체는 어디로도 가지 않고, 수집기가 개인정보 검사와 분류를 거쳐 승인함 후보로 만든다. 팀에는 승인한 카드만 올라간다.

type Phase = "queued" | "reading" | "ocr" | "sending" | "done" | "error";

interface Item {
  key: number;
  file: File;
  phase: Phase;
  progress: { done: number; total: number } | null; // ocr·sending 일 때
  outcome: UploadOutcome | null;
  error: string | null;
}

const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);
const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

export function FileUploadCard() {
  const { status, available, checked } = useCollectorStatus();
  const team = useTeam();
  const local = useMockCandidates();
  const [items, setItems] = useState<Item[]>([]);
  const [owner, setOwner] = useState(false); // 문서 담당자 확인: 올릴 때마다 다시 체크한다
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const busyRef = useRef(false);
  const nextKey = useRef(1);

  const connected = USE_MOCK || (available && !!status);
  const queued = items.filter((i) => i.phase === "queued");
  const patch = (key: number, change: Partial<Item>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i)));

  const addFiles = (files: FileList | File[] | null) => {
    if (!files || busyRef.current) return;
    const incoming = [...files];
    const fresh = incoming.filter((f) => !items.some((i) => sameFile(i.file, f)));
    if (fresh.length < incoming.length) toast.info("이미 목록에 있는 파일은 빼고 담았어요");
    setItems((prev) => [
      ...prev,
      ...fresh.map((file): Item => {
        const unsupported = unsupportedReason(file.name);
        const tooBig = file.size > MAX_FILE_BYTES ? `${MAX_FILE_BYTES / 1024 / 1024}MB 이하 파일을 올려 주세요.` : null;
        const error = unsupported ?? tooBig;
        return { key: nextKey.current++, file, phase: error ? "error" : "queued", progress: null, outcome: null, error };
      }),
    ]);
  };

  // 목업 모드: 읽은 조각을 이 브라우저의 규칙 분류기로 바로 후보로 만든다 (붙여넣기와 같은 방식)
  const classifyInBrowser = async (utterances: Utterance[]) => {
    const existingTopicKeys = [...(await boardTopicKeys().catch(() => new Set<string>()))];
    const cards = mockClassify(utterances, {
      userName: team.me,
      knownNames: [...new Set([...knownNamesOf(team), ...DEMO_KNOWN_NAMES])],
      existingTopicKeys,
    });
    local.replace(cards, "올린 자료");
  };

  const upload = async () => {
    if (busyRef.current || !owner || !queued.length) return;
    busyRef.current = true;
    setBusy(true);
    const mockUtterances: Utterance[] = [];
    const outcomes: UploadOutcome[] = [];
    let failed = 0;
    try {
      for (const item of queued) {
        patch(item.key, { phase: "reading", progress: null, error: null });
        let sending = false; // 보내기가 시작된 뒤의 실패는 일부가 이미 수집기에 들어갔을 수 있다
        const onPhase = (p: UploadPhase) => {
          if (p.phase === "sending") sending = true;
          patch(item.key, { phase: p.phase, progress: p.phase === "reading" ? null : { done: p.done, total: p.total } });
        };
        try {
          const outcome = await uploadFile(item.file, {
            mock: USE_MOCK,
            ocr: USE_MOCK ? null : createOcr(item.file.name),
            send: (messages, onProgress) => sendFileMessages(messages, { onProgress }),
            onPhase,
          });
          if (USE_MOCK) mockUtterances.push(...toMockUtterances(item.file.name, outcome.read.messages));
          outcomes.push(outcome);
          patch(item.key, { phase: "done", progress: null, outcome });
        } catch (error) {
          failed += 1;
          const note = sending ? " 일부는 이미 수집기에 들어갔을 수 있어요. 같은 파일을 다시 올리면 이미 올린 내용은 알아서 걸러져요." : "";
          patch(item.key, { phase: "error", progress: null, error: `${(error as Error).message}${note}` });
          if (error instanceof ExtensionMissing) break; // 나머지는 대기로 둔다
        }
      }
      if (USE_MOCK && mockUtterances.length) await classifyInBrowser(mockUtterances);
      const total = outcomes.length + failed;
      if (outcomes.length === 1 && !failed) toast[outcomes[0]!.tone](USE_MOCK ? "분류했어요. 승인함에서 팀에 올릴 내용을 골라 주세요" : outcomes[0]!.text);
      else if (total) {
        const warn = failed > 0 || outcomes.some((o) => o.tone === "warning");
        toast[warn ? "warning" : "success"](`파일 ${total}개 중 ${outcomes.length}개를 처리했어요${failed ? `, ${failed}개는 올리지 못했어요` : ""}. 결과는 목록에서 확인하세요`);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setOwner(false);
    }
  };

  const showReviewLink = items.some((i) => i.phase === "done" && (USE_MOCK ? i.outcome!.read.messages.length > 0 : (i.outcome!.summary?.stored ?? 0) > 0));

  return (
    <section className="space-y-4 rounded-xl border bg-card p-6" aria-labelledby="file-upload-title">
      <div className="space-y-1">
        <h2 id="file-upload-title" className="font-semibold">
          자료 올리기
        </h2>
        <p className="text-sm text-muted-foreground break-keep">
          회의록·기획서·메모 파일에서 팀에 남길 결정과 할 일을 찾아 승인함에 후보로 올려요. {SUPPORTED_LABEL} · 파일당 {MAX_FILE_BYTES / 1024 / 1024}MB, PDF는 {MAX_PDF_PAGES}쪽까지 읽어요.
        </p>
      </div>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed bg-background p-6 text-center text-sm hover:bg-muted/50 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          dragging && "border-brand bg-brand-soft",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <FileUp className="size-6 text-muted-foreground" />
        <span className="font-medium">파일을 끌어다 놓거나 눌러서 고르세요</span>
        <span className="text-xs text-muted-foreground">여러 파일을 한 번에 고를 수 있어요.</span>
        <input
          type="file"
          multiple
          accept={ACCEPT_EXTENSIONS.join(",")}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = ""; // 같은 파일을 다시 골라도 변경으로 잡히게
          }}
        />
      </label>

      {items.length > 0 && (
        <ul className="divide-y rounded-lg border bg-background px-3" aria-label="올릴 파일">
          {items.map((item) => (
            <FileRow key={item.key} item={item} busy={busy} onRemove={() => setItems((prev) => prev.filter((i) => i.key !== item.key))} />
          ))}
        </ul>
      )}

      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <Checkbox className="mt-0.5" checked={owner} onCheckedChange={(v) => setOwner(v === true)} disabled={busy} required aria-labelledby="file-upload-owner" />
        <span id="file-upload-owner" className="break-keep">
          이 자료를 팀에 대신 올리는 담당자예요 (내가 쓴 글이거나 팀이 함께 쓴 문서)
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {showReviewLink && (
            <Link href="/review" className={cn(buttonVariants({ variant: "outline" }), "h-9 px-3")}>
              승인함 보기
            </Link>
          )}
          {items.length > 0 && !busy && (
            <Button variant="ghost" size="sm" onClick={() => setItems([])}>
              목록 비우기
            </Button>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button className="h-9 bg-brand px-4 hover:bg-brand-hover" disabled={!owner || !queued.length || busy || !connected} onClick={upload}>
            {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
            {busy ? "올리는 중…" : queued.length ? `파일 ${queued.length}개 올리기` : "올리기"}
          </Button>
          {!connected && <p className="text-xs text-warn">{checked ? "로컬 수집기에 연결되면 올릴 수 있어요." : "수집기 연결을 확인하는 중이에요."}</p>}
        </div>
      </div>

      <p className="text-xs text-muted-foreground break-keep">파일은 이 PC에서만 읽어요. 글자 인식도 이 PC의 AI가 하고, 승인한 카드만 팀에 올라가요.</p>
    </section>
  );
}

function FileRow({ item, busy, onRemove }: { item: Item; busy: boolean; onRemove: () => void }) {
  const { phase, progress, outcome, error } = item;
  const pct = progress && progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex items-center gap-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" title={item.file.name}>
          {item.file.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{sizeLabel(item.file.size)}</span>
        <span className="flex shrink-0 items-center gap-1 text-xs" aria-live="polite">
          <PhaseStatus phase={phase} progress={progress} />
        </span>
        {!busy && phase !== "reading" && phase !== "ocr" && phase !== "sending" && (
          <button type="button" aria-label={`${item.file.name} 목록에서 빼기`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onRemove}>
            <X className="size-4" />
          </button>
        )}
      </div>
      {(phase === "ocr" || phase === "sending") && progress && progress.total > 0 && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {phase === "error" && error && (
        <p className="flex items-start gap-1.5 text-destructive" role="alert">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-keep">{error}</span>
        </p>
      )}
      {phase === "done" && outcome && <OutcomeView outcome={outcome} />}
    </li>
  );
}

function PhaseStatus({ phase, progress }: { phase: Phase; progress: Item["progress"] }) {
  switch (phase) {
    case "queued":
      return <span className="text-muted-foreground">대기 중</span>;
    case "reading":
      return <Spinning>읽는 중…</Spinning>;
    case "ocr":
      return <Spinning>{`글자 인식 중 ${progress?.done ?? 0}/${progress?.total ?? 0}쪽`}</Spinning>;
    case "sending":
      return <Spinning>{progress && progress.done > 0 ? `수집기로 보내는 중 ${progress.done}/${progress.total}조각` : "수집기로 보내는 중…"}</Spinning>;
    case "done":
      return (
        <span className="flex items-center gap-1 text-ok">
          <CheckCircle2 className="size-4" />
          완료
        </span>
      );
    case "error":
      return <span className="text-destructive">올리지 못함</span>;
  }
}

const Spinning = ({ children }: { children: React.ReactNode }) => (
  <span className="flex items-center gap-1 text-muted-foreground">
    <Loader2 className="size-3.5 animate-spin" />
    {children}
  </span>
);

function OutcomeView({ outcome }: { outcome: UploadOutcome }) {
  const { read, tone, text } = outcome;
  const groups = groupUnread(read.unread);
  const readPages = read.sections.length; // PDF 는 구획 하나가 한 쪽
  // 글자 인식 AI·수집기를 고치면 달라질 수 있는 이유가 있을 때만 '다시 올리기'를 권한다 (빈 쪽은 다시 해도 같다)
  const fixable = groups.some((g) => g.reason === "model_unavailable" || g.reason === "rpc_error");
  return (
    <div className="space-y-2">
      <p className={cn("break-keep", tone === "success" ? "text-ok" : "text-warn")}>
        {USE_MOCK ? `${text} 이 브라우저 안에서 분류했어요.` : text}
      </p>
      {read.ocrPages > 0 && <p className="text-xs text-muted-foreground">글자 인식으로 읽은 쪽 {read.ocrPages}쪽 (이 PC의 AI)</p>}
      {read.warnings.map((w) => (
        <p key={w} className="text-xs text-muted-foreground break-keep">
          {w}
        </p>
      ))}
      {groups.length > 0 && (
        <div className="space-y-1 rounded-lg bg-warn-soft px-3 py-2">
          <p className="font-medium text-warn">읽지 못한 쪽 {new Set(read.unread.map((u) => u.page)).size}쪽</p>
          <ul className="space-y-0.5">
            {groups.map((g) => (
              <li key={g.reason} className="break-keep">
                <b>{g.pages}</b> — {g.label}
                {g.detail ? ` (${g.detail})` : ""}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground break-keep">
            {readPages > 0 ? `나머지 ${readPages}쪽은 올렸어요. ` : ""}읽지 못한 쪽은 어디에도 보내지 않았어요.
            {fixable ? " 원인을 해결한 뒤 같은 파일을 다시 올리면 그 쪽만 새로 들어가요." : ""}
          </p>
        </div>
      )}
    </div>
  );
}
