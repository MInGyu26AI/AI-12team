"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { RepoLinkResult, RepoStatus } from "@shared/repo";
import { api } from "@/lib/api";
import { rpc } from "@/lib/rpc";
import { buttonOutline, buttonPrimary, input } from "@/components/ui/surface";

const reasons: Record<string, string> = {
  "bad-format": "저장소 주소·브랜치·토큰 형식을 확인해 주세요.",
  "token-needed": "이 저장소에 쓸 GitHub 토큰을 입력해 주세요.",
  "bad-token": "GitHub가 토큰을 받지 않았어요. 토큰을 다시 확인해 주세요.",
  "not-found": "저장소를 찾지 못했어요. 토큰에 이 저장소 접근 권한을 주세요.",
  "no-branch": "해당 브랜치가 없어요. 먼저 GitHub에서 브랜치를 만들어 주세요.",
  "no-write": "토큰에 Contents 읽기·쓰기 권한을 주세요.",
  "rate-limited": "GitHub 요청이 많아요. 잠시 후 다시 시도해 주세요.",
  unreachable: "GitHub에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.",
  "public-needs-consent": "공개 저장소에 팀 기록을 공개하는 데 동의해야 연결할 수 있어요.",
};

export function GithubLinkForm() {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [acceptPublic, setAcceptPublic] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("연결 정보를 확인하고 있어요.");
  const [error, setError] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getRepo().then(s => {
      if (!alive) return;
      setStatus(s); setRepo(s.repo ?? ""); setBranch(s.branch ?? "main"); setLoaded(true);
      setMessage(s.linked ? `${s.repo} · 연결됨` : "아직 연결된 저장소가 없어요.");
    }).catch(() => { if (alive) { setError(true); setMessage("연결 정보를 읽지 못했어요. PC 연결을 확인한 뒤 새로고침해 주세요."); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, []);

  async function run(action: "verify" | "link" | "unlink") {
    if (busy) return;
    setBusy(true); setError(false); setMessage("GitHub 연결을 확인하고 있어요.");
    try {
      const method = { verify: "team.verifyRepo", link: "team.linkRepo", unlink: "team.unlinkRepo" }[action];
      const data = action === "unlink" ? {} : { repo: repo.trim(), branch: branch.trim(), token, ...(action === "link" ? { acceptPublic } : {}) };
      const result = await rpc<RepoLinkResult>(method, data);
      if (!result.ok) {
        setError(true); setMessage(reasons[result.reason ?? ""] ?? "연결을 완료하지 못했어요. 다시 시도해 주세요.");
        return;
      }
      if (action === "verify") {
        setMessage(result.check?.private === false ? "권한 확인 완료 · 공개 저장소예요. 아래 공개 동의 후 연결해 주세요." : "권한 확인 완료 · 연결 버튼을 누르면 팀 기록 저장을 시작해요.");
      } else {
        setStatus(result.repo ?? null); setToken(""); setConfirmUnlink(false); setAcceptPublic(false);
        setMessage(action === "link" ? "저장소를 연결했어요. 이후 승인한 팀 기록을 저장해요." : "팀별 연결을 해제했어요. 기존 GitHub 파일은 유지돼요.");
      }
    } catch { setError(true); setMessage("연결 요청을 완료하지 못했어요. PC 연결 상태를 확인해 주세요."); }
    finally { setBusy(false); }
  }

  return <section className="space-y-4 rounded-[14px] border border-card-border bg-white p-6">
    <h2 className="text-lg font-bold">팀 기록 저장소</h2>
    <p className="text-sm text-muted-foreground">선택한 저장소에만 접근하는 GitHub 토큰을 사용해 주세요. Contents 읽기·쓰기 권한이 필요하며 토큰은 팀 서버에 보관돼요.</p>
    <fieldset disabled={busy || !loaded} className="space-y-4 disabled:opacity-60">
      <label className="block space-y-1"><span>저장소 주소</span><input className={input} value={repo} onChange={e => { setRepo(e.target.value); setAcceptPublic(false); }} placeholder="github.com/팀/저장소" /></label>
      <label className="block space-y-1"><span>저장 브랜치</span><input className={input} value={branch} onChange={e => setBranch(e.target.value)} /></label>
      <label className="block space-y-1"><span>GitHub 토큰</span><input type="password" autoComplete="off" className={input} value={token} onChange={e => setToken(e.target.value)} placeholder={status?.tokenSet && status.source === "team" ? "같은 저장소의 기존 토큰은 비워 두면 유지돼요" : "선택한 저장소의 접근 토큰"} /></label>
      <p className="text-xs text-muted-foreground">SYNCUP.md와 syncup.json을 저장해요. 같은 이름의 파일은 이후 팀 기록으로 갱신돼요.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={acceptPublic} onChange={e => setAcceptPublic(e.target.checked)} />공개 저장소인 경우 팀 기록이 공개되는 데 동의해요.</label>
      <div className="flex gap-2"><button className={buttonOutline} disabled={!repo.trim()} onClick={() => void run("verify")}>연결 확인</button><button className={buttonPrimary} disabled={!repo.trim()} onClick={() => void run("link")}>연결</button></div>
      {status?.linked && status.source === "team" && (confirmUnlink ? <div className="flex items-center gap-3 text-sm"><span>이 팀의 저장소 연결을 해제할까요?</span><button className={buttonOutline} onClick={() => void run("unlink")}>해제하기</button><button onClick={() => setConfirmUnlink(false)}>취소</button></div> : <button className="text-sm underline" onClick={() => setConfirmUnlink(true)}>연결 해제</button>)}
    </fieldset>
    {status?.state === "blocked" && <p role="alert" className="text-sm text-alert-conflict">비공개로 연결한 저장소가 공개로 바뀌어 저장을 멈췄어요. 공개 동의 후 다시 연결하거나 저장소를 비공개로 되돌려 주세요.</p>}
    {status?.source === "env" && <p className="text-sm text-muted-foreground">현재 서버 기본 저장소를 사용하고 있어요. 팀별 저장소를 연결하면 우선 적용돼요.</p>}
    <p role={error ? "alert" : "status"} className={error ? "text-sm text-alert-conflict" : "text-sm text-muted-foreground"}>{message}</p>
    <Link href="/board/notion" className="text-sm underline">노션 페이지에 팀 기록 저장하기</Link>
  </section>;
}
