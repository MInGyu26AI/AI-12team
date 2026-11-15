"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

type Account = { name: string; teams: { id: string; name: string }[] };
const field = "mt-2 w-full rounded-lg border bg-background px-3 py-3 outline-none focus:ring-2 focus:ring-brand";

export default function StartPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [topic, setTopic] = useState("");
  const [created, setCreated] = useState("");
  const [retrying, setRetrying] = useState(false);
  const request = useRef<{ id: string; name: string; topic: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const loginFailed = new URLSearchParams(location.search).has("error");
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal }).then(async (r) => {
      if (loginFailed) setError("로그인을 완료하지 못했어요. 취소했거나 시간이 지났다면 다시 시작해 주세요.");
      if (r.ok) setAccount(await r.json());
      else if (r.status !== 401) throw new Error("가입 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const r = await fetch("/api/onboarding/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      location.assign(data.url);
    } catch (e) { setError(e instanceof Error ? e.message : "로그인을 시작하지 못했어요."); setBusy(false); }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    // Keep the request ID on uncertain failures, so a retry cannot create a duplicate team.
    if (!request.current) request.current = { id: crypto.randomUUID(), name: team.trim(), topic: topic.trim() };
    setRetrying(true);
    try {
      const r = await fetch("/api/onboarding/teams", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: request.current.id, name: request.current.name, topic: request.current.topic }) });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) setAccount(null);
        // Explicit validation/refusal did not create a team. Let the user correct the fields.
        if (r.status < 500) { request.current = null; setRetrying(false); }
        throw new Error(data.error);
      }
      setCreated(data.name); request.current = null; setRetrying(false);
    } catch (e) { setError(e instanceof Error ? e.message : "팀을 만들지 못했어요. 같은 내용으로 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/onboarding", { method: "DELETE" });
      if (!r.ok) throw new Error("로그아웃하지 못했어요. 다시 시도해 주세요.");
      setAccount(null); setCreated(""); request.current = null; setRetrying(false);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return <main className="mx-auto max-w-2xl space-y-8 px-gutter py-12">
    <ol aria-label="시작 단계" className="flex gap-3 text-sm text-muted-foreground"><li className={!account ? "font-semibold text-brand" : ""}>1. GitHub 가입</li><li>→</li><li className={account && !created ? "font-semibold text-brand" : ""}>2. 팀 만들기</li><li>→</li><li>3. PC 연결</li></ol>
    <div><h1 className="text-3xl font-bold">{created ? `${created}, 시작할 준비가 됐어요` : account ? `${account.name}님, 함께할 팀을 만드세요` : "팀의 첫 결정을 함께 모아보세요"}</h1>
      <p className="mt-3 text-muted-foreground">GitHub 계정으로 가입하고 팀을 만든 뒤, 사용하는 PC를 연결해요. 관리자 등록은 필요 없어요.</p></div>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4 text-sm text-destructive">{error}</p>}
    {loading ? <p role="status">로그인 상태를 확인하고 있어요…</p> : created ? <section className="space-y-5 rounded-xl border bg-card p-6">
      <p className="flex gap-2"><Check className="text-brand" />팀과 프로젝트 주제가 저장됐어요.</p>
      <p>Mac 또는 Windows의 Chrome에서 확장과 SyncUp 연결 프로그램을 설치하면 대화를 모을 수 있어요.</p>
      <Link href="/install" className="inline-flex items-center gap-2 font-semibold text-brand">내 PC 연결하기 <ArrowRight size={18} /></Link>
    </section> : account ? <>
      {account.teams.length > 0 && <section className="space-y-3 rounded-xl border bg-card p-6"><h2 className="font-semibold">이미 참여한 팀</h2><ul>{account.teams.map(t => <li key={t.id} className="py-1">{t.name}</li>)}</ul><Link className="font-semibold text-brand underline" href="/install">기존 팀으로 PC 연결하기</Link></section>}
      <form onSubmit={create} className="space-y-5 rounded-xl border bg-card p-6"><h2 className="text-lg font-semibold">새 팀 만들기</h2>
        <label className="block text-sm font-medium">팀 이름<input required maxLength={80} value={team} disabled={busy || retrying} onChange={e => setTeam(e.target.value)} className={field} placeholder="예: 캠퍼스 길잡이" /></label>
        <label className="block text-sm font-medium">프로젝트 주제<textarea required maxLength={1200} value={topic} disabled={busy || retrying} onChange={e => setTopic(e.target.value)} className={field} placeholder="어떤 일을 함께 하나요? 수집할 대화를 구분하는 기준이 돼요." /></label>
        <p className="text-xs text-muted-foreground">계정당 팀을 3개까지 만들 수 있어요. 팀원은 PC 연결 후 초대할 수 있어요.</p>
        <Button disabled={busy || !team.trim() || !topic.trim()} type="submit">{busy ? "팀을 만들고 있어요…" : retrying ? "같은 요청 다시 확인하기" : "팀 만들고 계속하기"}</Button>
      </form><Button variant="ghost" disabled={busy} onClick={logout}>웹에서 로그아웃</Button><p className="text-xs text-muted-foreground">웹 로그아웃은 이 PC의 수집기 연결을 해제하지 않아요.</p>
    </> : <form onSubmit={login} className="space-y-5 rounded-xl border bg-card p-6">
      <label className="block text-sm font-medium">팀에 보일 내 이름<input required autoComplete="nickname" maxLength={40} className={field} value={name} onChange={e => setName(e.target.value)} placeholder="예: 김동균" /></label>
      <p className="text-sm text-muted-foreground">처음이면 가입하고, 이미 가입했다면 기존 계정으로 로그인해요. 기존 이름은 바뀌지 않아요.</p>
      <Button className="w-full" type="submit" disabled={busy || !name.trim()}>{busy ? "GitHub로 이동 중…" : "GitHub로 가입 / 로그인"}</Button>
      <p className="text-xs text-muted-foreground">팀원이 보낸 초대 링크가 있다면 그 링크로 참여해 주세요.</p>
    </form>}
  </main>;
}
