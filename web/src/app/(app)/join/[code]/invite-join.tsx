"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authorizeUrl, expiryText, supabaseOrigin, type SetupStatus } from "@/lib/github-login";
import { cleanName, isInviteCode, needsInstall, previewProblem, type InvitePreview } from "@/lib/invite";
import { ExtensionMissing, rpc } from "@/lib/rpc";

const SUPABASE = supabaseOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);

type View =
  | { kind: "checking" }
  | { kind: "install"; detail?: string } // 확장 또는 연결 프로그램이 없다: 키를 저장할 곳이 없으니 설치부터
  | { kind: "ready"; preview: Extract<InvitePreview, { status: "valid" }>; status: SetupStatus }
  | { kind: "error"; message: string };

// 실제 모드 초대 링크 (lib/invite.ts): 이 PC의 연결 프로그램을 확인하고, 링크의 팀·만료를 보여 준 뒤 GitHub 로그인으로 참여한다.
// 로그인 뒤 /auth/callback 이 setup.connect 를 부르면 연결 프로그램이 코드와 함께 팀 서버에 참여·키 발급을 요청한다.
export function InviteJoin({ code }: { code: string }) {
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") {
    return <Notice>초대 링크는 배포 웹에서 확장 프로그램을 거쳐 열어요. 확장을 설치한 크롬에서 받은 링크를 여세요.</Notice>;
  }
  if (!SUPABASE) return <Notice>웹 로그인이 아직 설정되지 않았어요. 링크를 보낸 팀원에게 알려 주세요.</Notice>;
  if (!isInviteCode(code)) return <Notice>초대 링크가 올바르지 않아요. 받은 링크 전체를 다시 열어 주세요.</Notice>;
  return <JoinPanel code={code} supabase={SUPABASE} />;
}

function JoinPanel({ code, supabase }: { code: string; supabase: string }) {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    (async () => {
      let status: SetupStatus;
      try {
        status = await rpc<SetupStatus>("setup.status");
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (error instanceof ExtensionMissing || needsInstall(message)) return setView({ kind: "install" });
        return setView({ kind: "error", message: message || "이 PC의 연결 프로그램에 닿지 못했어요." });
      }
      try {
        const preview = await rpc<InvitePreview>("setup.invite", { code });
        const problem = previewProblem(preview);
        if (problem || preview.status !== "valid") return setView({ kind: "error", message: problem ?? "" });
        setView({ kind: "ready", preview, status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "초대 링크를 확인하지 못했어요.";
        setView(needsInstall(message) ? { kind: "install", detail: message } : { kind: "error", message });
      }
    })();
  }, [code]);

  const clean = cleanName(name);
  const start = async () => {
    if (!clean) return;
    setStarting(true); // 한 번만: 다시 누르면 앞선 로그인의 verifier 가 바뀐다
    try {
      const { challenge } = await rpc<{ challenge: string }>("setup.begin", { invite: { code, name: clean } });
      location.assign(authorizeUrl(supabase, location.origin, challenge));
    } catch (error) {
      setStarting(false);
      setView({ kind: "error", message: error instanceof Error ? error.message : "로그인을 시작하지 못했어요." });
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-6 px-gutter py-16">
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <Users className="size-6 text-brand" />
        {view.kind === "ready" ? `${view.preview.team}에 참여하기` : "팀 초대"}
      </h1>
      <div className="space-y-3 rounded-xl border bg-card p-6 text-sm">
        {view.kind === "checking" && <p className="text-muted-foreground">초대 링크와 이 PC의 연결 프로그램을 확인하는 중…</p>}
        {view.kind === "install" && (
          <>
            <p className="break-keep">
              참여하려면 이 PC에 SyncUp 확장 프로그램과 연결 프로그램이 먼저 있어야 해요. 팀 연결 키를 이 PC에 저장하기 때문이에요.
            </p>
            {view.detail && <p className="break-keep text-muted-foreground">{view.detail}</p>}
            <Link href="/install" className="inline-block font-semibold text-brand underline">
              설치 안내로 가기
            </Link>
            <p className="break-keep text-muted-foreground">설치를 마친 뒤 이 초대 링크를 다시 여세요.</p>
          </>
        )}
        {view.kind === "error" && <p className="break-keep text-destructive">{view.message}</p>}
        {view.kind === "ready" && (
          <>
            <p className="break-keep">
              {expiryText(view.preview.expiresAt)}까지 쓸 수 있는 링크예요 · 팀원 {view.preview.members}/{view.preview.memberLimit}명
            </p>
            <label className="block space-y-2">
              <span className="font-semibold">팀에 보일 내 이름</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && start()}
                maxLength={40}
                placeholder="예: 윤채원"
                className="h-11 w-full rounded-lg border bg-background px-3.5 outline-none focus:border-brand"
              />
              <span className="block text-xs text-muted-foreground break-keep">
                처음 참여할 때만 이 이름으로 등록돼요. 이미 SyncUp 계정이 있으면 원래 이름을 그대로 써요.
              </span>
            </label>
            {view.status.keyPresent && (
              <p className="text-xs text-muted-foreground break-keep">이 PC의 이전 연결 키는 새 키로 바뀌어요. 수집기가 켜져 있다면 다시 켜 주세요.</p>
            )}
            <Button className="h-11 w-full bg-brand hover:bg-brand-hover" disabled={!clean || starting} onClick={start}>
              {starting ? "GitHub로 이동하는 중…" : "GitHub로 참여"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md space-y-4 px-gutter py-16">
      <h1 className="text-2xl font-bold">팀 초대</h1>
      <p className="break-keep">{children}</p>
    </div>
  );
}
