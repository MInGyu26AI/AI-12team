"use client";

import { useState } from "react";
import { FileArchive, Sparkles } from "lucide-react";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Utterance } from "@shared/classify";
import { readChatGPTExport, type ExportConversation } from "@/lib/chatgpt-export";

export function ExportUpload({ busy, onClassify }: { busy: boolean; onClassify: (u: Utterance[]) => void }) {
  const [convs, setConvs] = useState<ExportConversation[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setError(null);
    setConvs(null);
    setPicked(new Set());
    try {
      setConvs(await readChatGPTExport(file)); // 브라우저 안에서만 읽음, 업로드 없음
    } catch (e) {
      setError(e instanceof SyntaxError ? "JSON 파일을 읽을 수 없어요" : (e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const shown = convs?.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())) ?? [];

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed bg-background p-6 text-center text-sm hover:bg-muted/50">
        <FileArchive className="size-6 text-muted-foreground" />
        <span className="font-medium">ChatGPT 내보내기 zip 또는 conversations.json 선택</span>
        <span className="text-xs text-muted-foreground">파일은 이 브라우저 안에서만 열려요. 서버로 보내지 않아요.</span>
        <input
          type="file"
          accept=".zip,.json,application/zip,application/json"
          className="sr-only"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </label>

      {reading && <p className="text-sm text-muted-foreground">파일 여는 중…</p>}
      {error && <ErrorState message={error} />}

      {convs && (
        <div className="space-y-2">
          {convs.length === 0 ? (
            <p className="text-sm text-muted-foreground">대화가 없는 파일이에요.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  대화 {convs.length}개 · <b>{picked.size}개 선택</b> — 팀 관련 대화만 체크하세요
                </p>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="제목 검색"
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm sm:w-48"
                />
              </div>
              <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border bg-background">
                {shown.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                      <Checkbox checked={picked.has(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {c.date?.toLocaleDateString("ko-KR") ?? "날짜 없음"} · {c.utterances.length}개 발화
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end">
                <Button
                  disabled={!picked.size || busy}
                  onClick={() => onClassify(convs.filter((c) => picked.has(c.id)).flatMap((c) => c.utterances))}
                >
                  <Sparkles />
                  {busy ? "분류 중…" : `선택한 대화 ${picked.size}개 분류하기`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
