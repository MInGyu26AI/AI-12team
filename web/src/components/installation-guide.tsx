"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowRight, Check, CheckCircle2, ChevronDown, Copy, Download, FolderOpen, GitBranch, Info, Laptop, Monitor, Puzzle, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChromeExtensionsVisual, ExtensionAddressVisual, ExtensionIdVisual } from "@/components/installation-visuals";
import { ExtensionMissing, rpc } from "@/lib/rpc";
import type { SetupStatus } from "@/lib/github-login";

export type DesktopDownload = { name: string; detail: string; url: string | null };
const subscribe = () => () => {};
const defaultNext = () => "/connect";

const steps = [
  { id: "download", label: "앱 받기", icon: Download },
  { id: "extension", label: "Chrome 확장 연결", icon: Puzzle },
  { id: "github", label: "GitHub로 PC 연결", icon: GitBranch },
  { id: "check", label: "연결 확인", icon: CheckCircle2 },
];

function InstallStep({ number, id, title, description, children }: { number: number; id: string; title: string; description: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-44 rounded-xl border bg-card p-5 sm:p-8 md:scroll-mt-24">
    <div className="mb-6 flex items-start gap-3 sm:gap-4">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand text-sm font-bold text-white">{number}</span>
      <div><h2 id={`${id}-title`} className="text-lg font-bold tracking-tight sm:text-xl">{title}</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p></div>
    </div>
    {children}
  </section>;
}

function GuideAction({ number, children }: { number: number; children: ReactNode }) {
  return <li className="flex gap-3 text-sm leading-7"><span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-bold">{number}</span><span>{children}</span></li>;
}

function installationNext() {
  const value = new URLSearchParams(location.search).get("next");
  return value && /^\/join\/[A-Za-z0-9_-]{24}$/.test(value) ? value : "/connect";
}

export function InstallationGuide({ downloads, version }: { downloads: DesktopDownload[]; version: string }) {
  const next = useSyncExternalStore(subscribe, installationNext, defaultNext);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyAddress = async () => {
    try { await navigator.clipboard.writeText("chrome://extensions"); setCopied(true); setCopyError(false); }
    catch { setCopied(false); setCopyError(true); }
  };
  const check = async () => {
    setBusy(true); setReady(false); setStatus("");
    try {
      const host = await rpc<SetupStatus>("setup.status");
      if (!host.hostReady) throw new Error("SyncUp 앱에서 이 PC 연결을 마쳐 주세요.");
      if (!host.keyPresent) { setStatus("확장과 연결 프로그램을 찾았어요. 아래에서 GitHub로 이 PC를 연결하세요."); return; }
      await rpc("collection.status");
      setReady(true); setStatus("이 PC의 로그인과 실행 중인 수집기를 확인했어요.");
    } catch (e) {
      setStatus(e instanceof ExtensionMissing ? "확장 프로그램이 응답하지 않아요. 설치 후 이 페이지를 새로고침하고 확장의 개인 검토함 주소를 확인해 주세요." : "SyncUp 앱에서 GitHub 연결과 수집기 실행을 확인해 주세요. 연결이 끝나면 다시 확인할 수 있어요.");
    } finally { setBusy(false); }
  };
  return <div className="space-y-5 break-keep sm:space-y-6">
    <nav aria-label="PC 설치 순서" className="pb-3">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">{steps.map(({ id, label, icon: Icon }, index) => <li key={id}><a href={`#${id}`} className="flex h-full items-center gap-2 rounded-lg px-3 py-3 text-xs font-medium hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:text-sm"><Icon aria-hidden="true" className="size-4 shrink-0" /><span>{index + 1}. {label}</span></a></li>)}</ol>
    </nav>

    <InstallStep number={1} id="download" title="내 컴퓨터에 맞는 앱 받기" description="받은 파일의 압축을 풀고 SyncUp 앱을 여세요. Python이나 개발 도구를 따로 설치할 필요 없어요.">
      <div className="grid gap-3 sm:grid-cols-3">{downloads.map(d => <div key={d.name} className="flex flex-col items-start rounded-xl border border-card-border p-5">
        {d.name === "Windows" ? <Monitor aria-hidden="true" className="mb-4 size-6" /> : <Laptop aria-hidden="true" className="mb-4 size-6" />}
        <h3 className="text-sm font-bold">{d.name}</h3><p className="mt-1 mb-5 text-xs leading-relaxed text-muted-foreground">{d.detail}</p>
        {d.url ? <a className="mt-auto inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-xs font-semibold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" href={d.url} rel="noreferrer" aria-label={`${d.name} 설치 파일 받기`}><Download aria-hidden="true" className="size-4" />설치 파일 받기</a> : <p className="mt-auto text-sm text-muted-foreground">설치 파일 배포 준비 중</p>}
      </div>)}</div>
      {downloads.every(d => !d.url) && <p role="status" className="mt-4 text-sm">아직 설치 파일이 공개되지 않았어요. 가입과 팀 생성은 먼저 마칠 수 있어요. 다운로드가 준비된 뒤 이 페이지에서 계속해 주세요.</p>}
    </InstallStep>

    <InstallStep number={2} id="extension" title="그림을 보며 Chrome 확장 연결하기" description="SyncUp 앱과 Chrome을 함께 열어 주세요. 아래 그림은 눌러야 할 위치를 보여주는 화면 예시예요.">
      <div className="grid items-center gap-7 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-10">
        <div>
          <h3 className="text-base font-bold">먼저, 확장 폴더를 Chrome에 추가해요</h3>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">SyncUp 앱에서 <strong className="font-semibold text-foreground">확장 폴더 열기</strong>를 누르세요. 그다음 아래 주소를 복사해 Chrome 주소창에 붙여넣으세요.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><ExtensionAddressVisual /></div><Button variant="outline" onClick={copyAddress} className="h-10 px-3" aria-label="Chrome 확장 관리 주소 복사">{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "복사 완료" : "주소 복사"}</Button></div>
          <p role="status" className="mt-2 text-xs leading-relaxed text-muted-foreground">{copyError ? "복사하지 못했어요. chrome://extensions를 직접 입력해 주세요." : copied ? "Chrome 주소창에 붙여넣고 Enter를 누르세요." : "주소: chrome://extensions"}</p>
          <ol className="mt-5 space-y-3"><GuideAction number={1}>오른쪽 위 <strong>개발자 모드</strong>를 켜세요.</GuideAction><GuideAction number={2}><strong>압축해제된 확장 프로그램 로드</strong>를 누르고, SyncUp 앱에서 열린 폴더를 선택하세요.</GuideAction></ol>
          <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><FolderOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0" />설치가 끝나도 확장 폴더는 옮기거나 지우지 마세요.</p>
        </div>
        <ChromeExtensionsVisual />
      </div>
      <div className="my-8 border-t sm:my-10" />
      <div className="grid items-center gap-7 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-10">
        <div>
          <h3 className="text-base font-bold">이제, 내 확장 ID로 PC를 연결해요</h3>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">Chrome에 생긴 <strong className="font-semibold text-foreground">싱크업 SyncUp</strong> 카드를 찾으세요. 설명 아래에 내 확장 프로그램 ID가 있어요.</p>
          <ol className="mt-5 space-y-3"><GuideAction number={3}>카드의 <strong>ID 32자리</strong>를 복사해 SyncUp 앱에 붙여넣으세요.</GuideAction><GuideAction number={4}>앱에서 <strong>백업하고 이 PC에 설치</strong>를 누르세요.</GuideAction></ol>
          <div className="mt-5 rounded-lg bg-surface-soft p-4 text-xs leading-6 text-muted-foreground"><Info aria-hidden="true" className="mb-2 size-4" />기존 연결 설정은 앱이 백업해요. 이전 데이터와 연결 키는 지우지 않고, 관리자 비밀번호도 요구하지 않아요.</div>
        </div>
        <ExtensionIdVisual version={version} />
      </div>
      <div className="mt-8 flex items-start gap-3 rounded-lg border border-card-border bg-surface-soft p-4 text-sm leading-6"><RefreshCw aria-hidden="true" className="mt-1 size-4 shrink-0" /><p>확장 팝업의 <strong>개인 검토함 주소</strong>가 현재 사이트 주소인지 확인한 뒤, <strong>이 페이지를 새로고침</strong>해 주세요.</p></div>
    </InstallStep>

    <div className="grid items-start gap-5 lg:grid-cols-2 lg:gap-6">
      <InstallStep number={3} id="github" title="GitHub로 이 PC 연결하기" description="웹 가입과 PC 연결은 별도예요. 웹에서 로그인한 것과 같은 GitHub 계정으로 연결하세요.">
        <Link href={next} className="inline-flex max-w-full items-center gap-2 rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"><GitBranch aria-hidden="true" className="size-4 shrink-0" />{next.startsWith("/join/") ? "받은 초대 링크로 돌아가 참여하기" : "GitHub로 이 PC 연결하기"}</Link>
        <p className="mt-4 text-xs leading-6 text-muted-foreground">아직 가입하지 않았다면 <Link href="/start" className="font-semibold text-brand underline underline-offset-4">가입하고 팀 만들기</Link>부터 시작하세요. 초대받았다면 위 버튼으로 초대 링크에 돌아가세요.</p>
      </InstallStep>
      <InstallStep number={4} id="check" title="수집기를 켜고 연결 확인하기" description="SyncUp 앱에서 연결 상태를 새로 확인하고 팀을 선택한 뒤 ‘수집기 실행’을 누르세요.">
        <Button onClick={check} disabled={busy} className="h-auto min-h-11 px-4 py-3">{busy ? <RefreshCw aria-hidden="true" className="motion-safe:animate-spin" /> : <CheckCircle2 aria-hidden="true" />}{busy ? "연결 확인 중…" : "내 PC 연결 확인"}</Button>
        {status && <p role="status" className={`mt-4 rounded-lg p-3 text-sm leading-6 ${ready ? "bg-ok-soft text-ok" : "bg-surface-soft text-foreground"}`}>{status}</p>}
        {ready && <Link href="/collect" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-brand underline underline-offset-4">대화 수집으로 가기<ArrowRight aria-hidden="true" className="size-4" /></Link>}
        <p className="mt-4 text-xs leading-6 text-muted-foreground">연결을 마친 뒤 자동 수집은 Chrome 확장 팝업에서 직접 켜요. 내가 승인한 카드만 팀에 공유돼요.</p>
      </InstallStep>
    </div>

    <details className="group rounded-xl border border-card-border p-5 sm:p-6"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">자동 분류를 사용하려면<ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" /></summary>
      <p className="mt-3 text-sm">현재 버전은 PC의 개인정보 검사 모델과 개인 OpenAI API 키를 사용해요. 준비되지 않으면 분류가 대기하므로 설치 완료와 분류 준비를 구분해서 확인하세요.</p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm"><li><a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="underline">Ollama</a>를 설치하고 실행하세요.</li><li>Ollama에서 <code>gemma4:e4b-it-qat</code> 모델을 준비하세요. 터미널에서는 <code>ollama pull gemma4:e4b-it-qat</code>로 받을 수 있어요.</li><li>SyncUp 앱의 ‘자동 분류 준비’에 본인의 OpenAI API 키를 넣고 수집기를 실행하세요. 키는 이번 실행 동안만 사용하고 파일에 저장하지 않아요.</li></ol>
    </details>
    <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-muted-foreground"><Smartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0" />휴대폰에서는 가입과 팀 생성까지 할 수 있어요. 대화 수집은 Mac·Windows의 Chrome과 SyncUp 앱에서 이어가세요.</p>
  </div>;
}
