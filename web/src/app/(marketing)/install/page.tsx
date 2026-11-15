import type { Metadata } from "next";
import { InstallationGuide } from "@/components/installation-guide";
import release from "@/lib/extension-release.json";

export const metadata: Metadata = { title: "내 PC 연결 · 싱크업", description: "Mac·Windows에서 직접 SyncUp을 설치하고 GitHub로 연결하세요." };

function download(value: string | undefined) {
  if (value && /^\/downloads\/[A-Za-z0-9._-]+\.zip$/.test(value)) return value;
  try { const u = new URL(value ?? ""); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}

export default function InstallPage() {
  const downloads = [
    { name: "Mac · Apple Silicon", detail: "M1·M2·M3·M4 등 Apple 칩", url: download(process.env.NEXT_PUBLIC_DESKTOP_MAC_ARM64_URL) },
    { name: "Mac · Intel", detail: "Intel 프로세서 Mac", url: download(process.env.NEXT_PUBLIC_DESKTOP_MAC_INTEL_URL) },
    { name: "Windows", detail: "Windows 10·11, x64", url: download(process.env.NEXT_PUBLIC_DESKTOP_WINDOWS_URL) },
  ];
  return <main className="mx-auto max-w-3xl space-y-8 px-gutter py-12"><div><p className="text-sm font-semibold text-brand">가입 → 팀 만들기 → PC 연결</p><h1 className="mt-3 text-3xl font-bold">내 컴퓨터에 SyncUp 연결하기</h1><p className="mt-3 text-muted-foreground">앱의 안내를 따라 설치하고, 마지막에 연결을 직접 확인해요.</p></div><InstallationGuide downloads={downloads} version={release.version} />
    <details className="rounded-xl border p-5"><summary>확장만 업데이트할 때</summary><p className="mt-3 text-sm"><a href="/syncup-extension.zip" download className="text-brand underline">확장 ZIP 받기</a> → 기존 확장 폴더에 압축을 풀고 Chrome 확장 관리 화면에서 새로고침하세요. ChatGPT 탭도 새로고침해 주세요.</p></details>
  </main>;
}
