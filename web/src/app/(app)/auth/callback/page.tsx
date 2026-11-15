"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CALLBACK_PATH, CONNECT_TIMEOUT_MS, callbackResult, expiryText, type ConnectResult } from "@/lib/github-login";
import { rpc } from "@/lib/rpc";

type View = { kind: "working" } | { kind: "done"; result: ConnectResult } | { kind: "error"; message: string };

// 한 code 는 한 번만 넘긴다. 개발 모드의 React 가 effect 를 두 번 실행해도 연결 프로그램은 한 번만 부른다
const handled = new Set<string>();

// Supabase 가 GitHub 로그인 뒤 돌려보내는 화면: 주소의 code 를 지우고 이 PC의 연결 프로그램에 넘긴다 (lib/github-login.ts)
export default function AuthCallbackPage() {
  const [view, setView] = useState<View>({ kind: "working" });

  useEffect(() => {
    const parsed = callbackResult(location.search);
    history.replaceState(null, "", CALLBACK_PATH); // code 를 주소창과 방문 기록에서 지운다
    let answer: Promise<ConnectResult>;
    if ("code" in parsed) {
      if (handled.has(parsed.code)) return;
      handled.add(parsed.code);
      answer = rpc<ConnectResult>("setup.connect", { code: parsed.code }, CONNECT_TIMEOUT_MS);
    } else {
      if (handled.size) return; // 두 번째 실행: 주소의 code 는 첫 실행이 이미 지웠다
      answer = Promise.reject(new Error(parsed.error));
    }
    answer.then(
      (result) => setView({ kind: "done", result }),
      (error) => setView({ kind: "error", message: error instanceof Error ? error.message : "연결 키를 받지 못했어요." }),
    );
  }, []);

  return (
    <div className="mx-auto max-w-md space-y-6 px-gutter py-16">
      <h1 className="text-2xl font-bold">팀 연결 키 받기</h1>
      <div className="space-y-3 rounded-xl border bg-card p-6 text-sm">
        {view.kind === "working" && <p className="text-muted-foreground">이 PC에 연결 키를 저장하는 중…</p>}
        {view.kind === "error" && (
          <>
            <p className="break-keep text-destructive">{view.message}</p>
            <Link href="/connect" className="underline">
              처음부터 다시 하기
            </Link>
          </>
        )}
        {view.kind === "done" && (
          <>
            <p className="font-semibold break-keep" role="status">
              연결됐어요: {view.result.name} · {view.result.teams.join(", ") || "소속 팀 없음"} · {expiryText(view.result.expiresAt)}까지
            </p>
            <p className="text-muted-foreground break-keep">
              이제 수집기를 켜세요. 실행 명령에서 <code>--team-api</code>와 <code>--team-token-file</code>은 빼도 돼요. 수집기가 이미 켜져 있었다면
              다시 켜야 새 키를 써요.
            </p>
            <Link href="/collect" className="underline">
              대화 수집으로 가기
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
