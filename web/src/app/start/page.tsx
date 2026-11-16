"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/brand";
import { LogoutButton } from "@/components/logout-button";
import { consentUrl, isConsentRefusal, readAccount, type Account } from "@/lib/auth-navigation";
import { EnTitle } from "@/components/page-title";

const field = "mt-2 w-full rounded-lg border bg-background px-3 py-3 outline-none focus:ring-2 focus:ring-brand";

export default function StartPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [consentNeeded, setConsentNeeded] = useState(false); // 서버가 '먼저 약관에 동의해 주세요'(403)로 거절함
  const [team, setTeam] = useState("");
  const [topic, setTopic] = useState("");
  const [created, setCreated] = useState("");
  const [retrying, setRetrying] = useState(false);
  const request = useRef<{ id: string; name: string; topic: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal }).then(async (r) => {
      if (r.ok) setAccount(readAccount(await r.json()));
      else if (r.status === 401) location.replace("/login");
      else throw new Error("가입 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setConsentNeeded(false);
    // Keep the request ID on uncertain failures, so a retry cannot create a duplicate team.
    if (!request.current) request.current = { id: crypto.randomUUID(), name: team.trim(), topic: topic.trim() };
    setRetrying(true);
    try {
      const r = await fetch("/api/onboarding/teams", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: request.current.id, name: request.current.name, topic: request.current.topic }) });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) { setAccount(null); location.replace("/login?next=%2Fstart"); }
        setConsentNeeded(isConsentRefusal(r.status, data.error));
        // Explicit validation/refusal did not create a team. Let the user correct the fields.
        if (r.status < 500) { request.current = null; setRetrying(false); }
        throw new Error(data.error);
      }
      setCreated(data.name); request.current = null; setRetrying(false);
    } catch (e) { setError(e instanceof Error ? e.message : "팀을 만들지 못했어요. 같은 내용으로 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  return <main className="mx-auto max-w-2xl space-y-8 px-gutter py-12">
    <div className="flex items-center justify-between gap-4"><Brand />{account && <LogoutButton />}</div>
    <ol aria-label="시작 단계" className="flex gap-3 text-sm text-muted-foreground"><li className={!account ? "font-semibold text-brand" : ""}>1. GitHub 가입</li><li>→</li><li className={account && !created ? "font-semibold text-brand" : ""}>2. 팀 만들기</li><li>→</li><li>3. PC 연결</li></ol>
    <div><EnTitle>Let&apos;s get started.</EnTitle><h1 className="text-3xl font-bold">{created ? `${created}, 시작할 준비가 됐어요` : account ? `${account.name}님, 함께할 팀을 만드세요` : "팀의 첫 결정을 함께 모아보세요"}</h1>
      <p className="mt-3 text-muted-foreground">GitHub 계정으로 가입하고 팀을 만든 뒤, 사용하는 PC를 연결해요. 관리자 등록은 필요 없어요.</p></div>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4 text-sm text-destructive">
      {error}{consentNeeded && <> <Link href={consentUrl("/start")} className="font-semibold underline">약관 동의하러 가기</Link></>}
    </p>}
    {loading ? <p role="status">로그인 상태를 확인하고 있어요…</p> : created ? <section className="space-y-5 rounded-xl border bg-card p-6">
      <p className="flex gap-2"><Check className="text-brand" />팀과 프로젝트 주제가 저장됐어요.</p>
      <p>Mac 또는 Windows의 Chrome에서 확장과 SyncUp 연결 프로그램을 설치하면 대화를 모을 수 있어요.</p>
      <Link href="/install" className="inline-flex items-center gap-2 font-semibold text-brand">내 PC 연결하기 <ArrowRight size={18} /></Link>
    </section> : account ? <>
      {account.teams.length > 0 && <section className="space-y-3 rounded-xl border bg-card p-6"><h2 className="font-semibold">내 팀</h2><ul>{account.teams.map(t => <li key={t.id} className="py-1">{t.name}</li>)}</ul><div className="flex flex-wrap gap-4"><Link className="font-semibold text-brand underline" href="/collect">연결된 팀으로 들어가기</Link><Link className="font-semibold text-brand underline" href="/install">새 PC 연결하기</Link></div></section>}
      <p className="text-sm text-muted-foreground">팀원에게 초대받았다면 받은 초대 링크를 열어 참여하세요.</p>
      <form onSubmit={create} className="space-y-5 rounded-xl border bg-card p-6"><h2 className="text-lg font-semibold">새 팀 만들기</h2>
        <label className="block text-sm font-medium">팀 이름<input required maxLength={80} value={team} disabled={busy || retrying} onChange={e => setTeam(e.target.value)} className={field} placeholder="예: 캠퍼스 길잡이" /></label>
        <label className="block text-sm font-medium">프로젝트 주제<textarea required maxLength={1200} value={topic} disabled={busy || retrying} onChange={e => setTopic(e.target.value)} className={field} placeholder="어떤 일을 함께 하나요? 수집할 대화를 구분하는 기준이 돼요." /></label>
        <p className="text-xs text-muted-foreground">계정당 팀을 3개까지 만들 수 있어요. 팀원은 PC 연결 후 초대할 수 있어요.</p>
        <Button disabled={busy || !team.trim() || !topic.trim()} type="submit">{busy ? "팀을 만들고 있어요…" : retrying ? "같은 요청 다시 확인하기" : "팀 만들고 계속하기"}</Button>
      </form><p className="text-xs text-muted-foreground">웹 로그아웃은 이 PC의 수집기 연결을 해제하지 않아요. 수집도 멈추려면 확장에서 자동 수집을 꺼 주세요.</p>
    </> : <Link href="/login" className="font-semibold text-brand underline">GitHub 로그인으로 계속하기</Link>}
  </main>;
}
