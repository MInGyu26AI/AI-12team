"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { expiryText } from "@/lib/github-login";
import { inviteState, inviteUrl, type CreatedInvite, type InviteList } from "@/lib/invite";
import { rpc } from "@/lib/rpc";

const STATE_LABEL = { open: "사용 중", expired: "만료", revoked: "회수" } as const;

// 실제 모드 팀원 초대 (lib/invite.ts): 수집기에 연결된 팀의 초대 링크를 만들고, 목록을 보고, 회수한다.
// 서버는 코드의 해시만 갖고 있어서 링크 주소는 만든 직후 이 화면에서 한 번만 보인다.
export function InvitePanel() {
  const [list, setList] = useState<InviteList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await rpc<InviteList>("team.invites"));
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "초대 링크 목록을 불러오지 못했어요.");
    }
  }, []);
  useEffect(() => {
    rpc<InviteList>("team.invites").then(
      (value) => setList(value),
      (error) => setProblem(error instanceof Error ? error.message : "초대 링크 목록을 불러오지 못했어요."),
    );
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const result = await rpc<CreatedInvite>("team.createInvite");
      if (!result.created) toast.error("열린 초대 링크가 이미 5개예요. 안 쓰는 링크를 회수한 뒤 다시 만드세요.");
      else setMade({ url: inviteUrl(location.origin, result.code), expiresAt: result.expires_at });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "초대 링크를 만들지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await rpc("team.revokeInvite", { id });
      toast.success("초대 링크를 회수했어요. 이제 이 링크로는 참여할 수 없어요");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "회수하지 못했어요.");
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("초대 링크를 복사했어요. 카카오톡·디스코드에 붙여넣으세요");
    } catch {
      toast.error("복사에 실패했어요");
    }
  };

  return (
    <section className="space-y-4 rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <Link2 className="size-5 text-brand" />
          팀원 초대
        </h2>
        {list && (
          <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand">
            팀원 {list.members}/{list.member_limit}명
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground break-keep">
        링크 하나를 여러 명이 쓸 수 있고 7일 뒤 만료돼요. 받은 사람은 GitHub로 로그인해 바로 참여해요. 언제든 회수할 수 있어요.
      </p>
      {problem && <p className="text-sm text-destructive break-keep">{problem} 수집기가 켜져 있는지 대화 수집 화면에서 확인하세요.</p>}
      <Button className="h-11 bg-brand px-5 hover:bg-brand-hover" disabled={busy || !!problem} onClick={create}>
        {busy ? "만드는 중…" : "초대 링크 만들기"}
      </Button>
      {made && (
        <div className="space-y-2 rounded-lg border border-brand/30 bg-brand-soft/40 p-3">
          <div className="flex gap-2">
            <input readOnly value={made.url} aria-label="초대 링크" className="h-11 w-full rounded-lg border bg-background px-3.5 text-sm" />
            <Button variant="outline" className="h-11 shrink-0 px-4" onClick={() => copy(made.url)}>
              <Copy />
              복사
            </Button>
          </div>
          <p className="text-xs text-muted-foreground break-keep">
            {expiryText(made.expiresAt)}까지 쓸 수 있어요. 이 주소는 지금만 보여요. 잃어버리면 회수하고 새로 만드세요.
          </p>
        </div>
      )}
      {list && list.invites.length > 0 && (
        <ul className="divide-y text-sm">
          {list.invites.map((invite) => {
            const state = inviteState(invite);
            return (
              <li key={invite.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="font-medium">{invite.created_by}</span>
                <span className="text-muted-foreground">
                  {expiryText(invite.created_at)} 만듦 · {expiryText(invite.expires_at)}까지 · {invite.joined}명 참여
                </span>
                <span className="ml-auto rounded-full bg-muted px-2.5 py-1 text-xs">{STATE_LABEL[state]}</span>
                {state === "open" && (
                  <Button variant="outline" size="sm" onClick={() => revoke(invite.id)}>
                    회수
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
