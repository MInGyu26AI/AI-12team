"use client";

import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { rawFileUrl, repoFileUrl, type RepoStatus } from "@shared/repo";
import { Markdown } from "@/components/markdown";
import { EmptyState, LoadingState } from "@/components/states";
import { Button, buttonVariants } from "@/components/ui/button";

type Doc = { state: "loading" } | { state: "error" } | { state: "ready"; text: string };

// 팀 보드 '팀 기록' 탭: 연결된 레포의 SYNCUP.md 를 그대로 보여 주고, GitHub 보기 · syncup.json 내려받기 · 팀 기록 복사
export function TeamRecord({ status, onCopy }: { status: RepoStatus | null; onCopy: () => void }) {
  const linked = !!status?.linked && !!status.commit;
  const url = linked ? rawFileUrl(status, "SYNCUP.md") : null;
  const [doc, setDoc] = useState<Doc>({ state: "loading" });

  useEffect(() => {
    if (!url) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 커밋이 바뀌면 새 파일을 읽는 동안 불러오는 중으로
    setDoc({ state: "loading" });
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => alive && setDoc({ state: "ready", text }))
      .catch(() => alive && setDoc({ state: "error" }));
    return () => {
      alive = false;
    };
  }, [url]);

  // 다른 출처 파일은 <a download> 가 무시되므로 받아서 내려받기로 넘긴다
  const downloadJson = async () => {
    try {
      const r = await fetch(rawFileUrl(status!, "syncup.json"), { cache: "no-store" });
      if (!r.ok) throw new Error();
      const href = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement("a"), { href, download: "syncup.json" });
      a.click();
      URL.revokeObjectURL(href);
    } catch {
      toast.error("syncup.json 을 내려받지 못했어요. 잠시 뒤 다시 시도해 주세요");
    }
  };

  const copyButton = (
    <Button variant="outline" onClick={onCopy}>
      <Copy />팀 기록 복사
    </Button>
  );

  if (!linked) {
    return (
      <EmptyState title={status?.linked ? "레포에 아직 저장된 기록이 없어요" : "레포에 연결되지 않은 팀이에요"}>
        <p className="break-keep">
          {status?.linked
            ? "결정을 승인하거나 충돌을 처리하면 팀 서버가 SYNCUP.md 를 레포에 저장해요."
            : "레포 연결은 팀 서버 관리자가 정해요. 지금은 '팀 기록 복사'로 AI에 붙여넣을 수 있어요."}
        </p>
        <div className="mt-2 flex justify-center">{copyButton}</div>
      </EmptyState>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 sm:p-6" aria-label="팀 기록">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-muted-foreground">
          {status.repo} · <code>SYNCUP.md</code> (팀 서버가 자동으로 저장, 직접 고치지 않아요)
        </p>
        <a href={repoFileUrl(status, "SYNCUP.md")} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
          <ExternalLink />
          GitHub에서 보기
        </a>
        <Button variant="outline" onClick={downloadJson}>
          <Download />
          syncup.json 내려받기
        </Button>
        {copyButton}
      </div>
      {doc.state === "loading" && <LoadingState label="팀 기록을 불러오는 중…" />}
      {doc.state === "error" && <p className="text-sm text-alert-conflict">SYNCUP.md 를 불러오지 못했어요. GitHub에서 직접 열어 보세요.</p>}
      {doc.state === "ready" && <Markdown source={doc.text} />}
    </section>
  );
}
