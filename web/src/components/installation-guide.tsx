"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { ChromeExtensionSteps } from "@/components/installation-visuals";
import { Button } from "@/components/ui/button";
import { ExtensionMissing, rpc } from "@/lib/rpc";
import type { SetupStatus } from "@/lib/github-login";

export type DesktopDownload = { name: string; detail: string; url: string | null };
const subscribe = () => () => {};
const defaultNext = () => "/connect";
function installationNext() {
  const value = new URLSearchParams(location.search).get("next");
  return value && /^\/join\/[A-Za-z0-9_-]{24}$/.test(value) ? value : "/connect";
}

export function InstallationGuide({ downloads, version }: { downloads: DesktopDownload[]; version: string }) {
  const next = useSyncExternalStore(subscribe, installationNext, defaultNext);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const check = async () => {
    setBusy(true); setReady(false);
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
  return <div className="space-y-7">
    <section className="rounded-xl border bg-card p-6"><h2 className="text-lg font-semibold">1. 내 컴퓨터에 맞는 SyncUp 앱 받기</h2>
      <p className="mt-2 text-sm text-muted-foreground">Python이나 개발 도구를 따로 설치할 필요 없어요. 받은 파일의 압축을 풀고 SyncUp 앱을 여세요. Windows는 폴더 안의 <b>SyncUp.exe</b>만 실행하면 돼요. 함께 있는 <code>_internal</code> 폴더(실행에 필요한 파일)는 지우거나 옮기지 말고 그대로 두세요.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">{downloads.map(d => <div key={d.name} className="rounded-lg border p-4"><h3 className="font-semibold">{d.name}</h3><p className="mt-1 text-xs text-muted-foreground">{d.detail}</p>
        {d.url ? <a className="mt-4 inline-block font-semibold text-brand underline" href={d.url} rel="noreferrer">설치 파일 받기</a> : <p className="mt-4 text-sm text-muted-foreground">설치 파일 배포 준비 중</p>}</div>)}</div>
      {downloads.every(d => !d.url) && <p role="status" className="mt-4 text-sm">아직 설치 파일이 공개되지 않았어요. 가입과 팀 생성은 먼저 마칠 수 있어요. 다운로드가 준비된 뒤 이 페이지에서 계속해 주세요.</p>}
    </section>
    <section className="border bg-card p-4 sm:p-6" aria-labelledby="install-chrome-title">
      <h2 id="install-chrome-title" className="scroll-mt-24 text-lg font-semibold">2. Chrome 확장 설치</h2>
      <p className="mt-3 text-sm leading-6 break-keep text-ink-body">
        SyncUp 앱에서 <strong>확장 폴더 열기</strong>를 누른 다음, Chrome 주소창에{" "}
        <code className="inline-block bg-surface-soft px-1.5 text-ink">chrome://extensions</code>를 입력하세요.
      </p>
      <ChromeExtensionSteps />
      <p className="mt-6 border-t pt-4 text-sm leading-6 break-keep text-ink-body">
        확장 팝업의 <strong>개인 검토함 주소</strong>가 현재 사이트 주소인지 확인한 뒤 이 페이지를 새로고침하세요.
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">확장 v{version} · 기존 연결 설정은 앱이 백업해요.</p>
    </section>
    <section className="rounded-xl border bg-card p-6"><h2 className="text-lg font-semibold">3. GitHub로 이 PC 연결</h2><p className="mt-2 text-sm text-muted-foreground">웹 가입과 PC 연결은 별도예요. 같은 GitHub 계정으로 연결하면 이 PC에 안전하게 연결 키가 저장돼요.</p>
      <Link href={next} className="mt-4 inline-block font-semibold text-brand underline">{next.startsWith("/join/") ? "받은 초대 링크로 돌아가 참여하기" : "GitHub로 이 PC 연결하기"}</Link>
      <p className="mt-3 text-sm">아직 가입하지 않았다면 <Link href="/start" className="text-brand underline">가입하고 팀 만들기</Link>부터 시작하세요. 초대받았다면 위의 초대 링크로 계속하면 됩니다.</p>
    </section>
    <section className="rounded-xl border bg-card p-6"><h2 className="text-lg font-semibold">4. 앱에서 수집기를 켜고 연결 확인</h2><p className="mt-2 text-sm text-muted-foreground">SyncUp 앱으로 돌아가 연결 상태를 새로 확인하고 팀을 선택한 뒤 수집기를 실행하세요. 자동 수집은 확장 팝업에서 직접 켜요.</p>
      <Button onClick={check} disabled={busy} className="mt-4">{busy ? "연결 확인 중…" : "내 PC 연결 확인"}</Button>
      {status && <p role="status" className="mt-3 text-sm">{status}</p>}
      {ready && <Link href="/collect" className="mt-4 block font-semibold text-brand underline">연결 완료 · 대화 수집으로 가기</Link>}
    </section>
    <details className="rounded-xl border p-6"><summary className="cursor-pointer font-semibold">자동 분류를 사용하려면</summary>
      <p className="mt-3 text-sm leading-6">분류는 SyncUp이 제공하는 AI로 처리해요. 먼저 내 PC에서 개인정보를 검사할 수 있도록 Ollama와 검사 모델을 준비해 주세요.</p>
      <ol className="mt-4 list-decimal space-y-5 pl-5 text-sm leading-6">
        <li>
          <p>내 컴퓨터에 맞는 Ollama를 설치하고 실행하세요.</p>
          <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center border border-ink bg-ink px-4 py-2 font-semibold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink">Ollama 다운로드<span className="sr-only"> (새 탭)</span></a>
        </li>
        <li>
          <p>터미널에서 아래 명령으로 개인정보 검사 모델을 내려받으세요.</p>
          <pre className="mt-2 overflow-x-auto border bg-surface-soft p-3 text-sm"><code>ollama pull gemma4:e4b-it-qat</code></pre>
          <p className="mt-2 text-xs text-muted-foreground">모델 다운로드가 끝날 때까지 기다려 주세요. 준비되지 않으면 대화는 PC에 보류돼요.</p>
        </li>
        <li>SyncUp 앱에서 팀을 선택하고 <strong>수집기 실행</strong>을 누르세요. 자동 수집은 Chrome 확장 팝업에서 켜요.</li>
      </ol>
      <p className="mt-4 text-xs leading-6 text-muted-foreground">개인정보 검사를 통과한 내용만 SyncUp 서버를 거쳐 OpenAI로 보내며, 중계 내용은 서버에 저장하지 않아요. 서버 AI가 준비되지 않았거나 사용 한도를 넘으면 분류가 대기해요.</p>
    </details>
    <p className="text-sm text-muted-foreground">휴대폰에서는 가입과 팀 생성까지 진행할 수 있지만, 대화 수집은 Mac·Windows의 Chrome과 SyncUp 앱이 필요해요.</p>
  </div>;
}
