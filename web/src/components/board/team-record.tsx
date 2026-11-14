"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, Copy, Download, ExternalLink, FileText } from "lucide-react";
import { toast } from "sonner";
import { fmtMDHM } from "@shared/format";
import { rawFileUrl, repoFileUrl, repoShortName, sinceText, type RepoStatus } from "@shared/repo";
import type { Conflict, RelatedCard } from "@shared/types";
import { LoadingState } from "@/components/states";
import { buttonOutline, buttonPrimary, card } from "@/components/ui/surface";
import { boardToMarkdown } from "@/lib/board-markdown";
import { cn } from "@/lib/utils";

type FileName = "SYNCUP.md" | "syncup.json";
type Doc = { state: "loading" } | { state: "error" } | { state: "ready"; text: string };

// 팀 상태 파일 화면 (피그마 7-2 179:7 레포 연결 전 · 7-3 169:2 연결 후). 예전 보드의 '팀 기록' 탭을 별도 화면으로 키웠다.
// 연결 후: 레포의 SYNCUP.md · syncup.json 을 그대로 보여 준다 (GitHub에서 보기 · JSON 내려받기 · 복사).
// 연결 전(또는 아직 첫 저장 전): 팀 보드로 만든 미리보기를 보여 주고, 복사·JSON 내려받기는 미리보기로 한다
export function TeamRecord({ status, cards, conflicts, done, teamName }: {
  status: RepoStatus | null;
  cards: RelatedCard[];
  conflicts: Conflict[];
  done: Set<string>;
  teamName: string;
}) {
  const saved = !!status?.linked && !!status.commit;
  const [file, setFile] = useState<FileName>("SYNCUP.md");
  const repoDoc = useRepoFile(saved ? status : null, file);
  const preview = file === "SYNCUP.md" ? boardToMarkdown(cards, conflicts) : previewJson(cards, done, teamName);
  const text = saved ? (repoDoc.state === "ready" ? repoDoc.text : null) : preview;

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("복사됨! 새 AI 대화나 코딩 AI에 붙여넣으세요");
    } catch {
      toast.error("클립보드 복사에 실패했어요. 브라우저 권한을 확인해 주세요");
    }
  };

  // 다른 출처 파일은 <a download> 가 무시되므로 받아서 내려받기로 넘긴다
  const downloadJson = async () => {
    try {
      const blob = saved
        ? await fetch(rawFileUrl(status!, "syncup.json"), { cache: "no-store" }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error())))
        : new Blob([previewJson(cards, done, teamName)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href, download: "syncup.json" });
      a.click();
      URL.revokeObjectURL(href);
    } catch {
      toast.error("syncup.json 을 내려받지 못했어요. 잠시 뒤 다시 시도해 주세요");
    }
  };

  return (
    <div className="mx-auto max-w-[1280px] space-y-4 px-gutter py-8 sm:px-10">
      <Link href="/board" className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-3.5" aria-hidden />
        팀 결정 기록으로
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-medium sm:text-[28px]">팀 상태 파일</h1>
          <p className="text-[13px] text-muted-foreground break-keep">
            {saved
              ? "레포의 SYNCUP.md에 저장된 내용이에요. 새 AI 대화나 코딩 AI에 그대로 붙여 넣을 수 있어요."
              : "레포에 저장될 SYNCUP.md 내용이에요. 연결 전에도 복사해서 새 AI 대화나 코딩 AI에 붙여 넣을 수 있어요."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cn(buttonOutline, "h-10 px-4 py-0 text-[13px]")} onClick={copy} disabled={text === null}>
            <Copy className="size-3.5" />
            복사
          </button>
          <button type="button" className={cn(buttonOutline, "h-10 px-4 py-0 text-[13px]")} onClick={downloadJson}>
            <Download className="size-3.5" />
            JSON 내려받기
          </button>
          {saved ? (
            <a href={repoFileUrl(status!, file)} target="_blank" rel="noreferrer" className={cn(buttonPrimary, "h-10 px-4 py-0 text-[13px]")}>
              <ExternalLink className="size-3.5" />
              GitHub에서 보기
            </a>
          ) : (
            <span aria-disabled="true" className={cn(buttonPrimary, "h-10 cursor-not-allowed bg-[#a8a29a] px-4 py-0 text-[13px] hover:bg-[#a8a29a]")}>
              <ExternalLink className="size-3.5" />
              GitHub에서 보기
            </span>
          )}
        </div>
      </div>

      {!saved && <NotSavedNotice linked={!!status?.linked} />}

      <div className="flex gap-1" role="tablist" aria-label="팀 상태 파일">
        {(["SYNCUP.md", "syncup.json"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={file === f}
            onClick={() => setFile(f)}
            className={cn(
              "rounded-md px-3 py-1.5 font-mono text-xs",
              file === f ? "border border-card-border bg-white font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <section className={cn(card, "overflow-hidden rounded-[14px]")} aria-label={file}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border bg-[#faf6f0] px-6 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2 font-mono text-foreground">
            <FileText className="size-3.5 text-muted-foreground" aria-hidden />
            {saved ? `${repoShortName(status!.repo)} / ${file}` : `${file} · 미리보기`}
          </span>
          <span>
            {saved
              ? [status!.branch, status!.commit!.sha.slice(0, 7), status!.commit!.at && sinceText(status!.commit!.at)].filter(Boolean).join(" · ")
              : "레포에 아직 저장되지 않음"}
          </span>
        </div>
        <div className="px-5 py-6 sm:px-8">
          {saved && repoDoc.state === "loading" && <LoadingState label={`${file} 을 불러오는 중…`} />}
          {saved && repoDoc.state === "error" && (
            <p className="text-sm text-alert-conflict">{file} 을 불러오지 못했어요. GitHub에서 직접 열어 보세요.</p>
          )}
          {text !== null && <pre className="font-mono text-[13px] leading-[1.9] whitespace-pre-wrap break-words">{text}</pre>}
        </div>
      </section>
    </div>
  );
}

// 레포 미연결(7-2) · 연결했지만 아직 첫 저장 전 안내
function NotSavedNotice({ linked }: { linked: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[12px] bg-brand-soft/70 px-4 py-2.5 text-[13px]">
      <Image src="/brand/github.svg" alt="" width={16} height={16} unoptimized />
      <p className="min-w-0 flex-1 break-keep">
        {linked
          ? "레포에 아직 저장된 기록이 없어요. 결정을 승인하거나 충돌을 처리하면 팀 서버가 SYNCUP.md 를 레포에 저장해요."
          : "아직 레포에 저장되지 않았어요. 레포를 연결하면 이 내용이 SYNCUP.md로 저장돼요"}
      </p>
      {!linked && (
        <Link href="/board/repo" className={cn(buttonPrimary, "px-3.5 py-1.5 text-xs")}>
          레포 연결하기
        </Link>
      )}
    </div>
  );
}

// 연결된 레포의 파일. 커밋이 바뀌거나 탭을 바꾸면 새로 읽는다
function useRepoFile(status: RepoStatus | null, file: FileName): Doc {
  const url = status ? rawFileUrl(status, file) : null;
  const [doc, setDoc] = useState<Doc>({ state: "loading" });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 커밋·탭이 바뀌면 새 파일을 읽는 동안 불러오는 중으로
    setDoc({ state: "loading" });
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => alive && setDoc({ state: "ready", text: file === "syncup.json" ? pretty(text) : text }))
      .catch(() => alive && setDoc({ state: "error" }));
    return () => {
      alive = false;
    };
  }, [url, file]);
  return doc;
}

const pretty = (json: string) => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

// 레포 연결 전 syncup.json 미리보기: 팀 서버가 만드는 형식(docs/team-state.md)의 결정·할 일만 보드에서 옮긴다.
// 할 일 ID(SU-n)는 서버가 저장할 때 붙이므로 미리보기에는 없다
function previewJson(cards: RelatedCard[], done: Set<string>, teamName: string) {
  const topics = new Map<string, { card_id: string; content: string }[]>();
  for (const c of cards.filter((x) => x.tag === "decision")) {
    const key = c.topic_key ?? "기타";
    topics.set(key, [...(topics.get(key) ?? []), { card_id: c.id, content: c.content }]);
  }
  return JSON.stringify(
    {
      syncup_version: 1,
      preview: true,
      team: { name: teamName },
      updated_at: fmtMDHM(new Date()),
      decisions: [...topics].map(([topic_key, current]) => ({ topic_key, current })),
      todos: cards
        .filter((c) => c.tag === "todo")
        .map((c) => ({ card_id: c.id, content: c.content, owner: c.owner, due: c.due, topic_key: c.topic_key, done: done.has(c.id) })),
    },
    null,
    2,
  );
}
