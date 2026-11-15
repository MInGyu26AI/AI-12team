"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { USE_MOCK } from "@/lib/api";
import { authorizeUrl, expiryText, supabaseOrigin, type SetupStatus } from "@/lib/github-login";
import { ExtensionMissing, rpc } from "@/lib/rpc";

const SUPABASE = supabaseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);

type View =
  | { kind: "checking" }
  | { kind: "ready"; status: SetupStatus }
  | { kind: "missing" } // 확장이 요청을 받지 않음
  | { kind: "error"; message: string };

// 팀 연결 키 받기: GitHub 로그인으로 이 PC의 연결 키를 받는다 (lib/github-login.ts, docs/running.md)
export default function ConnectPage() {
  if (USE_MOCK || process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") {
    return <Notice>연결 키는 배포 웹에서 확장 프로그램을 거쳐 받아요. 확장을 설치한 크롬에서 배포 웹의 팀 연결 화면을 여세요.</Notice>;
  }
  if (!SUPABASE) return <Notice>웹 로그인이 아직 설정되지 않았어요. 팀 관리자에게 문의하세요.</Notice>;
  return <ConnectPanel supabase={SUPABASE} />;
}

function ConnectPanel({ supabase }: { supabase: string }) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    rpc<SetupStatus>("setup.status").then(
      (status) => setView({ kind: "ready", status }),
      (error) => setView(error instanceof ExtensionMissing ? { kind: "missing" } : { kind: "error", message: hostProblem(error) }),
    );
  }, []);

  const start = async () => {
    setStarting(true); // 한 번만: 다시 누르면 앞선 로그인의 verifier 가 바뀐다
    try {
      const { challenge } = await rpc<{ challenge: string }>("setup.begin");
      location.assign(authorizeUrl(supabase, location.origin, challenge));
    } catch (error) {
      setStarting(false);
      setView({ kind: "error", message: hostProblem(error) });
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-6 px-gutter py-16">
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <KeyRound className="size-6 text-brand" />
          팀 연결 키 받기
        </h1>
        <p className="text-sm text-muted-foreground break-keep">
          GitHub로 로그인하면 이 PC의 연결 프로그램이 연결 키를 만들어 저장해요. 키는 이 PC 밖으로 나가지 않고, 이 페이지도 보지 않아요.
          팀 관리자가 미리 등록한 GitHub 계정만 받을 수 있어요.
        </p>
      </div>
      <div className="space-y-3 rounded-xl border bg-card p-6 text-sm">
        {view.kind === "checking" && <p className="text-muted-foreground">이 PC의 연결 프로그램을 확인하는 중…</p>}
        {view.kind === "missing" && (
          <p className="break-keep">
            확장 프로그램이 응답하지 않아요. <Link href="/install" className="underline">확장 설치</Link>를 마치고, 확장 팝업의 개인 검토함 주소가 이
            사이트인지 확인하세요.
          </p>
        )}
        {view.kind === "error" && <p className="break-keep text-destructive">{view.message}</p>}
        {view.kind === "ready" && (
          <>
            <p className="break-keep">
              {view.status.keyPresent && view.status.expiresAt
                ? `이 PC는 ${expiryText(view.status.expiresAt)}까지 연결돼 있어요. 다시 받으면 이 PC의 이전 키는 폐기돼요.`
                : "이 PC에는 아직 연결 키가 없어요."}
            </p>
            <Button className="h-11 w-full bg-brand hover:bg-brand-hover" disabled={starting} onClick={start}>
              {starting ? "GitHub로 이동하는 중…" : "GitHub로 계속하기"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** 연결 프로그램에 닿지 못했을 때 할 일 (확장이 넘긴 Chrome 오류 문장을 함께 보여 준다) */
function hostProblem(error: unknown): string {
  const detail = error instanceof Error ? error.message : "";
  if (/native messaging host not found|로컬 수집기 연결 실패/i.test(detail)) {
    return "이 PC의 연결 프로그램(native host)을 찾지 못했어요. docs/running.md의 '확장 연결'대로 native-setup을 --team-api와 함께 한 번 해 주세요.";
  }
  return detail || "이 PC의 연결 프로그램에 닿지 못했어요. 확장과 연결 프로그램 설치를 확인하세요.";
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md space-y-4 px-gutter py-16">
      <h1 className="text-2xl font-bold">팀 연결 키 받기</h1>
      <p className="break-keep">{children}</p>
    </div>
  );
}
