"use client";

import { useEffect, useState } from "react";
import { rpc } from "@/lib/rpc";

export function DocumentConnections({ connected }: { connected: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError("");
    if (!connected) return;
    void rpc<{ setupUrl?: string }>("connectors.list").then((result) => {
      const value = new URL(result.setupUrl ?? "");
      if (value.protocol !== "http:" || value.hostname !== "127.0.0.1" || !value.port || value.pathname !== "/connectors" || value.username || value.password || value.search || value.hash) {
        throw new Error("SyncUp 앱을 최신 버전으로 업데이트하고 다시 실행해 주세요.");
      }
      if (!cancelled) setUrl(value.href);
    }).catch(() => {
      if (!cancelled) setError("연결 화면을 찾지 못했어요. 최신 SyncUp 앱에서 수집기를 실행한 뒤 다시 확인해 주세요.");
    });
    return () => { cancelled = true; };
  }, [connected, attempt]);

  return <section className="space-y-3 rounded-xl border bg-card p-6">
    <h2 className="font-semibold">노션·구글 문서 가져오기</h2>
    <p className="text-sm text-muted-foreground">이 PC의 연결 화면에서 가져올 문서를 직접 선택해요. 연결 정보는 PC에 저장되고, 가져온 글도 개인정보 검사와 개인 검토를 거쳐요.</p>
    {!connected ? <p className="text-sm">SyncUp 앱에서 수집기를 켜면 문서를 연결할 수 있어요.</p>
      : url ? <a href={url} target="_blank" rel="noreferrer" className="inline-block font-semibold text-brand underline">이 PC에서 문서 연결하기 ↗</a>
      : error ? <div role="status"><p className="text-sm">{error}</p><button className="mt-2 text-sm font-semibold text-brand underline" onClick={() => setAttempt(n => n + 1)}>다시 확인</button></div>
      : <p role="status" className="text-sm text-muted-foreground">문서 연결 화면을 확인하고 있어요…</p>}
  </section>;
}
