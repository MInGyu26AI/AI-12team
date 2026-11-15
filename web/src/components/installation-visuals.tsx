import { ArrowDown, FolderOpen, Menu, MoreHorizontal, Puzzle, RotateCw, Search } from "lucide-react";
import type { ReactNode } from "react";

function Marker({ children }: { children: ReactNode }) {
  return <span className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">{children}</span>;
}

function BrowserFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-card-border bg-white shadow-card">
    <div className="flex items-center gap-3 border-b bg-surface-soft px-3 py-3 sm:px-4">
      <div className="hidden gap-1.5 sm:flex"><span className="size-2 rounded-full bg-card-border" /><span className="size-2 rounded-full bg-card-border" /><span className="size-2 rounded-full bg-card-border" /></div>
      <div className="min-w-0 flex-1 rounded-md border border-border bg-white px-3 py-1.5 font-mono text-[11px] text-muted-foreground sm:text-xs">chrome://extensions</div>
      <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
    </div>
    {children}
  </div>;
}

/** Responsive explanatory drawings, not interactive Chrome controls or screenshots. */
export function ChromeExtensionsVisual() {
  return <figure aria-label="Chrome 확장 관리 화면 예시: 오른쪽 위 개발자 모드를 켠 뒤 왼쪽의 압축해제된 확장 프로그램 로드를 누르세요.">
    <div aria-hidden="true" className="select-none">
      <BrowserFrame>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Menu className="size-4" />확장 프로그램</div>
          <div className="ml-auto flex items-center gap-2 rounded-lg bg-tag-todo-soft p-2 ring-1 ring-card-border">
            <Marker>1</Marker><span className="text-xs font-semibold">개발자 모드</span>
            <span className="flex h-5 w-9 items-center justify-end rounded-full bg-brand p-0.5"><span className="size-4 rounded-full bg-white" /></span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b px-4 pb-5 sm:px-5">
          <div className="flex items-center gap-2 rounded-lg border border-brand bg-tag-todo-soft px-3 py-2.5"><Marker>2</Marker><span className="text-xs font-semibold sm:text-sm">압축해제된 확장 프로그램 로드</span></div>
          <span className="text-xs text-muted-foreground">업데이트</span>
        </div>
        <div className="m-4 flex items-center gap-3 rounded-lg border border-dashed border-card-border bg-surface-soft p-4 sm:m-5">
          <FolderOpen className="size-7 shrink-0 text-text-tertiary" />
          <div><p className="text-xs font-semibold sm:text-sm">SyncUp 앱에서 열린 확장 폴더</p><p className="mt-1 text-[11px] text-muted-foreground sm:text-xs">폴더 안의 파일이 아니라, 폴더 자체를 선택해요.</p></div>
        </div>
      </BrowserFrame>
    </div>
    <figcaption className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">Chrome 화면 예시 · 표시한 두 곳을 순서대로 눌러 주세요.</figcaption>
  </figure>;
}

export function ExtensionIdVisual({ version }: { version: string }) {
  return <figure aria-label="SyncUp 확장 카드의 설명 아래에 있는 ID를 복사해 SyncUp 앱의 확장 프로그램 ID 입력칸에 붙여넣는 화면 예시.">
    <div aria-hidden="true" className="select-none">
      <div className="rounded-xl border border-card-border bg-white p-4 shadow-card sm:p-5">
        <div className="flex items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-brand text-white"><Puzzle className="size-6" /></div>
          <div className="min-w-0"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-sm font-bold">싱크업 SyncUp</span><span className="text-xs text-muted-foreground">{version}</span></div><p className="mt-2 text-xs leading-relaxed text-muted-foreground">대화를 모으고, 내가 승인한 카드만 팀에 공유해요.</p></div>
        </div>
        <div className="mt-5 rounded-lg border border-brand bg-tag-todo-soft p-3">
          <div className="mb-2 flex items-center gap-2"><Marker>3</Marker><span className="text-xs font-semibold">이 줄의 ID를 복사해요</span><span className="ml-auto text-[10px] text-muted-foreground">예시 ID</span></div>
          <p className="break-all font-mono text-[11px] leading-relaxed sm:text-xs">ID: abcdefghijklmnopabcdefghijklmnop</p>
        </div>
        <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="rounded-full border px-3 py-1.5">세부정보</span><span className="rounded-full border px-3 py-1.5">삭제</span><RotateCw className="ml-auto size-4" /><span className="flex h-5 w-9 items-center justify-end rounded-full bg-brand p-0.5"><span className="size-4 rounded-full bg-white" /></span></div>
      </div>
      <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"><ArrowDown className="size-4" />복사한 ID를 SyncUp 앱에 붙여넣기</div>
      <div className="rounded-xl border border-card-border bg-surface-soft p-4 sm:p-5">
        <p className="text-xs font-semibold">SyncUp 앱 · 확장 프로그램 ID</p>
        <div className="mt-2 rounded-lg border border-card-border bg-white px-3 py-2.5 text-xs text-text-tertiary">Chrome에서 복사한 내 ID 32자리</div>
        <span className="mt-3 inline-block rounded-lg bg-brand px-3 py-2.5 text-xs font-semibold text-white">백업하고 이 PC에 설치</span>
      </div>
    </div>
    <figcaption className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">그림의 ID는 예시예요. 반드시 내 Chrome 카드에서 복사하세요.</figcaption>
  </figure>;
}

export function ExtensionAddressVisual() {
  return <div aria-hidden="true" className="flex items-center gap-2 rounded-lg border border-card-border bg-white px-3 py-2.5"><Search className="size-4 shrink-0 text-muted-foreground" /><code className="min-w-0 break-all text-xs sm:text-sm">chrome://extensions</code></div>;
}
