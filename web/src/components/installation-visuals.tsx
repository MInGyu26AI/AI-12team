import Image from "next/image";
import type { CSSProperties } from "react";

const extensionsScreenshot = "/installation/chrome-extensions-light.png";
const extensionIdScreenshot = "/installation/chrome-syncup-id-light.png";
const screenshotFrame = "relative bg-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink";

function StepNumber({ number, size = "size-6 text-xs" }: { number: number; size?: string }) {
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center bg-ink font-mono font-semibold leading-none text-white ${size}`}>
      {number}
    </span>
  );
}

function ScreenshotMark({ number, style }: { number: number; style: CSSProperties }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute border-[1.5px] border-ink" style={style}>
      <span className="absolute bottom-full -left-px"><StepNumber number={number} size="size-3.5 text-[9px] sm:size-4 sm:text-[10px]" /></span>
    </span>
  );
}

export function ChromeExtensionSteps() {
  return (
    <>
      <figure className="mt-5">
        <a href={extensionsScreenshot} target="_blank" rel="noreferrer"
          className={`block border ${screenshotFrame}`}
          aria-label="Chrome 확장 관리 화면 크게 보기 (새 탭)">
          <Image src={extensionsScreenshot} width={3040} height={340} unoptimized className="h-auto w-full"
            alt="Chrome 확장 관리 화면에서 오른쪽 위 개발자 모드와 왼쪽 위 확장 프로그램 로드 위치" />
          <ScreenshotMark number={1} style={{ left: "88.5%", top: "13%", width: "11%", height: "25%" }} />
          <ScreenshotMark number={2} style={{ left: "2%", top: "54%", width: "19.5%", height: "40%" }} />
        </a>
        <figcaption className="mt-2 text-xs leading-5 text-muted-foreground">화면을 누르면 크게 볼 수 있어요.</figcaption>
      </figure>

      <ol role="list" className="mt-5 space-y-4 text-sm leading-6 break-keep text-ink-body">
        <li className="flex items-start gap-3">
          <StepNumber number={1} />
          <p>오른쪽 위 <strong>개발자 모드</strong>를 켜세요.</p>
        </li>
        <li className="flex items-start gap-3">
          <StepNumber number={2} />
          <div className="min-w-0">
            <p><strong>압축해제된 확장 프로그램 로드</strong>를 누르고, SyncUp 앱에서 열린 폴더를 선택하세요.</p>
            <p className="mt-2 text-xs text-muted-foreground">설치 후에도 확장 폴더는 그대로 두세요.</p>
          </div>
        </li>
        <li className="border-t pt-5">
          <div className="flex items-start gap-3">
            <StepNumber number={3} />
            <p><strong>싱크업 SyncUp</strong> 카드의 <strong>ID 32자리</strong>를 SyncUp 앱에 붙여 넣고 <strong>백업하고 이 PC에 설치</strong>를 누르세요.</p>
          </div>
          <figure className="mt-3 max-w-lg">
            <a href={extensionIdScreenshot} target="_blank" rel="noreferrer"
              className={`block border ${screenshotFrame}`} aria-label="SyncUp 확장 ID 화면 크게 보기 (새 탭)">
              <Image src={extensionIdScreenshot} width={1180} height={445} unoptimized className="h-auto w-full"
                alt="Chrome의 싱크업 SyncUp 카드에서 설명 아래 ID가 표시된 위치" />
              <ScreenshotMark number={3} style={{ left: "21.5%", top: "69%", width: "60%", height: "14%" }} />
            </a>
            <figcaption className="mt-2 text-xs leading-5 text-muted-foreground">
              화면 속 ID는 예시예요. 내 Chrome에 표시된 ID를 복사하세요.
            </figcaption>
          </figure>
        </li>
      </ol>
    </>
  );
}
