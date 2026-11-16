import Image from "next/image";
import type { CSSProperties } from "react";

function ScreenshotMark({ number, style }: { number: number; style: CSSProperties }) {
  return <span aria-hidden="true" className="pointer-events-none absolute rounded-md border-2 border-brand sm:border-[3px]" style={style}>
    <span className="absolute top-0 left-0 grid size-5 -translate-x-1/3 -translate-y-1/2 place-items-center rounded-full bg-brand text-[10px] font-bold text-white sm:size-6 sm:text-xs">{number}</span>
  </span>;
}

// Actual Chrome captures; only annotations are rendered over the unchanged pixels.
export function ChromeExtensionsVisual() {
  return <figure>
    <a href="/installation/chrome-extensions-light.png" target="_blank" rel="noreferrer" aria-label="Chrome 확장 설치 스크린샷 크게 보기" className="relative hidden overflow-hidden rounded-lg border border-card-border bg-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand sm:block">
      <Image src="/installation/chrome-extensions-light.png" width={3040} height={340} unoptimized className="h-auto w-full" alt="라이트 모드 Chrome 확장 프로그램 화면. 오른쪽 위 개발자 모드와 왼쪽 아래 압축해제된 확장 프로그램 로드 버튼이 표시돼 있어요." />
      <ScreenshotMark number={1} style={{ left: "88.5%", top: "12%", width: "11%", height: "26%" }} />
      <ScreenshotMark number={2} style={{ left: "2%", top: "56%", width: "19.5%", height: "35%" }} />
    </a>
    <div className="space-y-4 sm:hidden">
      <a href="/installation/chrome-extensions-light.png" target="_blank" rel="noreferrer" aria-label="개발자 모드 위치의 전체 스크린샷 보기" className="relative block rounded-lg border border-card-border bg-white p-3">
        <span className="mb-2 block text-xs font-semibold">1. 오른쪽 위 개발자 모드</span>
        <Image src="/installation/chrome-developer-mode-light.png" width={365} height={135} unoptimized className="mx-auto h-auto w-48" alt="Chrome의 개발자 모드 스위치가 켜진 실제 화면" />
      </a>
      <a href="/installation/chrome-extensions-light.png" target="_blank" rel="noreferrer" aria-label="확장 로드 버튼 위치의 전체 스크린샷 보기" className="relative block rounded-lg border border-card-border bg-white p-3">
        <span className="mb-2 block text-xs font-semibold">2. 왼쪽 위 확장 프로그램 로드</span>
        <Image src="/installation/chrome-load-unpacked-light.png" width={625} height={145} unoptimized className="h-auto w-full" alt="Chrome의 압축해제된 확장 프로그램 로드 버튼 실제 화면" />
      </a>
    </div>
    <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">실제 Chrome 스크린샷 · 누르면 크게 볼 수 있어요.</figcaption>
  </figure>;
}

export function ExtensionIdVisual() {
  return <figure>
    <a href="/installation/chrome-syncup-id-light.png" target="_blank" rel="noreferrer" aria-label="SyncUp 확장 ID 스크린샷 크게 보기" className="relative block overflow-hidden rounded-lg border border-card-border bg-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">
      <Image src="/installation/chrome-syncup-id-light.png" width={1180} height={445} unoptimized className="h-auto w-full" alt="실제 Chrome의 싱크업 SyncUp 0.2.20 카드. 확장 설명 아래 ID 줄의 위치를 표시했어요." />
      <ScreenshotMark number={3} style={{ left: "21.5%", top: "69%", width: "60%", height: "14%" }} />
    </a>
    <figcaption className="mt-3 text-xs leading-relaxed text-muted-foreground">실제 확장 카드의 ID 부분을 확대한 화면이에요. 화면 속 ID 대신 내 Chrome의 ID를 복사하세요. 누르면 크게 볼 수 있어요.</figcaption>
  </figure>;
}
