"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import { EnTitle } from "@/components/page-title";
import { buttonOutline, buttonPrimary, card } from "@/components/ui/surface";
import { USE_MOCK } from "@/lib/api";
import { loginDestination, loginUrl, needsConsent, readAccount } from "@/lib/auth-navigation";
import { CONSENT_ITEMS, consentHint, consentLeft, noConsent, type ConsentId } from "@/lib/consent-items";
import { CONSENT_BODY } from "@/lib/legal";
import { cn } from "@/lib/utils";

// 가입 동의 화면의 본문 (디자인 Login.dc.html 2·4번). 주소 /signup/consent 의 page.tsx 가 탭 제목(metadata)만 정하고 이것을 그린다: GitHub 로그인 직후 아직 동의 기록이 없는(또는 문서 버전이 바뀐) 계정에만 보인다.
// 필수 4개를 모두 체크해야 '동의하고 시작하기'가 켜지고, 누르면 서버에 동의 기록(POST /api/onboarding/consent)을 남긴 뒤 가려던 화면으로 간다.
// '동의하지 않고 나가기'는 방금 만든 계정을 지운다(POST /api/onboarding/decline). 목업 모드는 서버가 없어 화면만 보여 주고 대시보드로 보낸다.

const subscribe = () => () => {};
const currentQuery = () => location.search;
const serverQuery = () => "";

type Phase = "checking" | "form" | "declined" | "error";

const checkbox = "size-5 shrink-0 cursor-pointer accent-ink";
const stepBox = "flex size-5 shrink-0 items-center justify-center text-[11px]";

export function ConsentForm() {
  const query = new URLSearchParams(useSyncExternalStore(subscribe, currentQuery, serverQuery));
  const next = loginDestination(query.get("next"));
  const [phase, setPhase] = useState<Phase>(USE_MOCK ? "form" : "checking");
  const [problem, setProblem] = useState(""); // 상태 확인 실패 안내
  const [attempt, setAttempt] = useState(0);
  const [checks, setChecks] = useState(noConsent);
  const [open, setOpen] = useState<ConsentId | null>(null);
  const [busy, setBusy] = useState<"" | "agree" | "decline">("");
  const [error, setError] = useState("");
  const allRef = useRef<HTMLInputElement>(null);
  const declinedTitle = useRef<HTMLHeadingElement>(null);
  const panelId = useId();

  const left = consentLeft(checks);
  const all = left === 0;
  const some = left < CONSENT_ITEMS.length;

  // 이미 동의한 계정이면 묻지 않고 가려던 화면으로, 로그인 세션이 없으면 로그인으로 보낸다
  useEffect(() => {
    if (USE_MOCK) return;
    const controller = new AbortController();
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { location.replace(loginUrl(next)); return; }
      if (!response.ok) throw new Error("로그인 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
      if (needsConsent(readAccount(await response.json()))) setPhase("form");
      else location.replace(next);
    }).catch((e: Error) => {
      if (controller.signal.aborted) return;
      setProblem(e.message || "가입 정보를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
      setPhase("error");
    });
    return () => controller.abort();
  }, [next, attempt]);

  // 일부만 체크했을 때 '모두 동의' 상자는 반쯤 찬 모양(indeterminate)으로 보인다
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = some && !all; }, [some, all, phase]);
  // 화면이 바뀌면(나가기) 키보드 초점이 사라지지 않게 새 제목으로 옮긴다
  useEffect(() => { if (phase === "declined") declinedTitle.current?.focus(); }, [phase]);

  const toggle = (id: ConsentId) => setChecks((current) => ({ ...current, [id]: !current[id] }));
  const toggleAll = () => setChecks({ age: !all, terms: !all, privacy: !all, transfer: !all });

  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch { return { status: 0, message: "연결하지 못했어요. 잠시 뒤 다시 시도해 주세요." }; }
    const data = await response.json().catch(() => ({}));
    return { status: response.status, message: response.ok ? "" : (typeof data?.error === "string" && data.error) || "요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요." };
  };

  const agree = async () => {
    if (!all || busy) return;
    if (USE_MOCK) { location.replace("/dashboard"); return; }
    setBusy("agree"); setError("");
    const result = await post("/api/onboarding/consent", CONSENT_BODY);
    if (result.status === 401) { location.replace(loginUrl(next)); return; }
    if (result.message) { setError(result.message); setBusy(""); return; } // 409(문서가 바뀜) 등 서버 안내를 그대로 보인다
    location.replace(next);
  };

  const decline = async () => {
    if (busy) return;
    if (USE_MOCK) { setChecks(noConsent()); setOpen(null); setPhase("declined"); return; }
    setBusy("decline"); setError("");
    const result = await post("/api/onboarding/decline", {});
    if (result.status === 401) { location.replace(loginUrl(next)); return; }
    setBusy("");
    if (result.message) { setError(result.message); return; } // 이미 동의했거나 팀이 있으면 409
    setChecks(noConsent()); setOpen(null); setPhase("declined");
  };

  const shell = "w-full max-w-[560px] space-y-5 rounded-2xl px-6 pt-9 pb-8 sm:px-10";

  if (phase === "checking" || phase === "error") {
    return (
      <Page>
        <section className={cn(card, "w-full max-w-[460px] space-y-4 rounded-2xl px-6 py-9 sm:px-10")} aria-label="가입 상태 확인">
          {phase === "checking" ? <p role="status" className="text-sm">가입 상태를 확인하고 있어요…</p> : <>
            <p role="alert" className="bg-sensitive-soft p-3 text-sm text-sensitive">{problem}</p>
            <button type="button" className={cn(buttonOutline, "w-full")} onClick={() => { setPhase("checking"); setAttempt((n) => n + 1); }}>다시 확인</button>
          </>}
        </section>
      </Page>
    );
  }

  if (phase === "declined") {
    return (
      <Page>
        <section aria-labelledby="declined-title" className={cn(card, "w-full max-w-[460px] space-y-5 rounded-2xl px-6 pt-10 pb-9 sm:px-10")}>
          <div className="space-y-1.5">
            <h1 id="declined-title" ref={declinedTitle} tabIndex={-1} className="text-2xl leading-[1.5] font-bold outline-none">가입을 마치지 않았어요</h1>
            <p className="text-sm leading-[1.6] text-ink-2 break-keep">동의하지 않아 가입을 멈췄어요. GitHub에서 받은 로그인 정보도 지웠어요.</p>
          </div>
          <Link href="/" className={cn(buttonOutline, "min-h-12 w-full text-[15px]")}>첫 화면으로</Link>
          <p className="text-xs leading-[1.6] text-ink-2 break-keep">마음이 바뀌면 다시 로그인해서 동의할 수 있어요.</p>
        </section>
      </Page>
    );
  }

  return (
    <Page>
      <section aria-labelledby="consent-title" className={cn(card, shell)}>
        <ol aria-label="가입 단계" className="button-mono flex flex-wrap items-center gap-x-2.5 gap-y-2 text-xs text-ink-2">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className={cn(stepBox, "bg-blush text-ink")}><Check className="size-3" /></span>GitHub 로그인 완료
          </li>
          <li aria-hidden className="h-px w-5 bg-ink" />
          <li aria-current="step" className="flex items-center gap-1.5 font-medium text-ink">
            <span aria-hidden className={cn(stepBox, "bg-ink text-white")}>2</span>약관 동의
          </li>
          <li aria-hidden className="h-px w-5 bg-ink" />
          <li className="flex items-center gap-1.5">
            <span aria-hidden className={cn(stepBox, "border border-ink-2")}>3</span>시작
          </li>
        </ol>

        <div className="space-y-1.5">
          <EnTitle>One more step.</EnTitle>
          <h1 id="consent-title" className="text-2xl leading-[1.5] font-bold">시작하기 전에 확인해 주세요</h1>
          <p className="text-sm leading-[1.5] text-muted-foreground break-keep">처음 한 번만 확인해요. 동의하지 않으면 GitHub에서 받은 로그인 정보를 바로 지워요.</p>
        </div>

        <div className="space-y-1.5 bg-blush px-4 py-3.5 text-[13px] leading-[1.6] break-keep">
          <p>SyncUp은 베타 서비스이며 무료예요.</p>
          <p>원본 대화는 내 PC에만 저장되고, 내가 승인한 카드만 팀에 공유돼요.</p>
          <p>카드를 뽑고 충돌을 확인할 때 가림 처리한 내용이 OpenAI(미국)로 전송돼요.</p>
        </div>

        <fieldset className="min-w-0">
          <legend className="sr-only">필수 동의 항목</legend>
          <label className="flex min-h-[52px] cursor-pointer items-center gap-3 border-b-[1.5px] border-ink px-1 text-base font-bold">
            <input ref={allRef} type="checkbox" checked={all} onChange={toggleAll} className={checkbox} />
            필수 항목에 모두 동의해요
          </label>
          <ul>
            {CONSENT_ITEMS.map((item) => {
              const isOpen = open === item.id;
              const id = `${panelId}-${item.id}`;
              return (
                <li key={item.id} className="border-b border-ink/15">
                  <div className="flex items-center justify-between gap-3 px-1">
                    <label className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm leading-[1.5] break-keep">
                      <input type="checkbox" checked={checks[item.id]} onChange={() => toggle(item.id)} className={checkbox} />
                      <span><span className="font-bold">[필수]</span> {item.label}</span>
                    </label>
                    {item.points && (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={id}
                        onClick={() => setOpen(isOpen ? null : item.id)}
                        className="min-h-11 shrink-0 px-2 text-[13px] underline underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ink"
                      >
                        {isOpen ? "접기" : "요약 보기"}
                        <span className="sr-only"> ({item.label})</span>
                      </button>
                    )}
                  </div>
                  {item.points && isOpen && (
                    <div id={id} className="mx-1 mb-3.5 ml-9 space-y-2 border-x border-y border-ink/15 bg-canvas px-3.5 py-3">
                      <ul className="list-disc space-y-1 pl-4 text-[13px] leading-[1.6] text-ink-body break-keep">
                        {item.points.map((point) => <li key={point}>{point}</li>)}
                      </ul>
                      {item.href && (
                        <Link href={item.href} target="_blank" rel="noopener noreferrer" className="flex min-h-8 items-center text-[13px] font-medium underline underline-offset-2">
                          {item.docLabel} 전문 보기 →<span className="sr-only"> (새 탭에서 열려요)</span>
                        </Link>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>

        {error && <p role="alert" className="bg-sensitive-soft p-3 text-sm text-sensitive break-keep">{error}</p>}

        <div className="space-y-2.5">
          <button type="button" disabled={!all || !!busy} aria-describedby="consent-hint" onClick={agree} className={cn(buttonPrimary, "min-h-12 w-full text-[15px]")}>
            {busy === "agree" ? "동의를 기록하고 있어요…" : "동의하고 시작하기"}
          </button>
          <p id="consent-hint" className="text-xs leading-[1.6] text-ink-2">{consentHint(left)}</p>
          <button
            type="button"
            disabled={!!busy}
            onClick={decline}
            className="mx-auto flex min-h-11 cursor-pointer items-center px-3 text-[13px] text-ink-2 underline underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-wait disabled:opacity-60"
          >
            {busy === "decline" ? "나가는 중…" : "동의하지 않고 나가기"}
          </button>
        </div>
      </section>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-center px-gutter pt-12 pb-24 sm:pt-14">{children}</div>;
}
