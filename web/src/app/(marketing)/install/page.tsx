import type { Metadata } from "next";
import { InstallationGuide } from "@/components/installation-guide";
import release from "@/lib/extension-release.json";
import { desktopDownloads } from "@/lib/desktop-downloads";
import { EnTitle } from "@/components/page-title";

export const metadata: Metadata = { title: "내 PC 연결 · 싱크업", description: "Mac·Windows에서 직접 SyncUp을 설치하고 GitHub로 연결하세요." };

export default function InstallPage() {
  // 설치 파일 목록은 대시보드 'PC 연결하기' 슬라이드와 같은 값(lib/desktop-downloads.ts)을 쓴다
  const downloads = desktopDownloads();
  return <main className="mx-auto max-w-5xl space-y-6 px-gutter py-10 sm:px-6 sm:py-14"><div className="max-w-2xl"><p className="text-sm font-medium text-muted-foreground">가입과 팀 만들기를 마쳤다면</p><EnTitle>Install SyncUp.</EnTitle><h1 className="mt-3 text-3xl leading-tight font-bold tracking-tight sm:text-4xl">내 PC에 SyncUp 연결하기</h1><p className="mt-4 text-sm leading-7 text-muted-foreground sm:text-base">앱을 받고, 그림을 따라 Chrome에 연결해요.<br className="hidden sm:block" /> 마지막에 연결을 확인하면 대화를 모을 준비가 끝나요.</p></div><InstallationGuide downloads={downloads} version={release.version} />
    <details className="rounded-xl border border-card-border p-5 sm:p-6"><summary className="cursor-pointer text-sm font-semibold">이미 설치했고, 확장만 업데이트할 때</summary><p className="mt-3 text-sm leading-7"><a href="/syncup-extension.zip" download className="font-semibold text-brand underline underline-offset-4">확장 ZIP 받기 (v{release.version})</a> → 기존 확장 폴더에 압축을 풀고 Chrome 확장 관리 화면에서 새로고침하세요. ChatGPT 탭도 새로고침해 주세요.</p></details>
  </main>;
}
