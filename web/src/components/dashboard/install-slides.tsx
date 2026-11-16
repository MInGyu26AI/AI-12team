"use client";

// 'PC 연결하기' 슬라이드 팝업 (6단계). 글·링크·확인 방법은 설치 안내 페이지(/install, components/installation-guide.tsx)와 같다.
// 설치 안내를 고칠 때는 두 곳을 같이 본다: 앱 받기 목록 lib/desktop-downloads.ts · 이 PC 연결 확인(check) · 초대 링크로 돌아갈 주소(installationNext)
import Image from "next/image";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { desktopDownloads } from "@/lib/desktop-downloads";
import release from "@/lib/extension-release.json";
import type { SetupStatus } from "@/lib/github-login";
import { ExtensionMissing, rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { DialogFrame, SlideFooter, slidePrimary } from "./dialog-frame";

const SLIDES = [
  { title: "내 컴퓨터에 맞는 SyncUp 앱 받기", body: "Python이나 개발 도구는 따로 설치하지 않아도 돼요" },
  { title: "Chrome에 확장 올리기", body: "SyncUp 앱에서 확장 폴더 열기를 누른 뒤 Chrome에서 그 폴더를 불러와요" },
  { title: "확장 ID를 앱에 붙여 넣기", body: "앱이 이 PC에 연결 프로그램을 설치하고 기존 설정은 백업해요" },
  { title: "GitHub로 이 PC 연결", body: "웹 가입과 PC 연결은 따로예요. 연결하면 이 PC에 연결 키가 저장돼요." },
  { title: "수집기를 켜고 연결 확인", body: "앱에서 팀을 고르고 수집기를 실행하세요. 자동 수집은 확장 팝업에서 켜요." },
  { title: "자동 분류 준비", body: "선택 단계예요. 준비가 안 되면 대화는 모이고 분류만 기다려요." },
] as const;

const TITLE_ID = "install-slide-title";
const card = "border border-card-border bg-[#fffdfa]";
const code = "bg-[#f3ebe6] px-1 font-mono text-[13px]";
const strong = "font-medium text-ink";

// 초대 링크로 들어왔다면 연결 뒤 그 팀으로 돌아간다 (installation-guide.tsx 와 같은 검사)
const subscribe = () => () => {};
const defaultNext = () => "/connect";
function installationNext() {
  const value = new URLSearchParams(location.search).get("next");
  return value && /^\/join\/[A-Za-z0-9_-]{24}$/.test(value) ? value : "/connect";
}

/** 5단계 '내 PC 연결 확인': installation-guide.tsx 의 check 와 같은 순서(setup.status → collection.status)·같은 결과 문구 */
function usePcCheck() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const check = async () => {
    setBusy(true);
    setReady(false);
    try {
      const host = await rpc<SetupStatus>("setup.status");
      if (!host.hostReady) throw new Error("SyncUp 앱에서 이 PC 연결을 마쳐 주세요.");
      if (!host.keyPresent) {
        setStatus("확장과 연결 프로그램을 찾았어요. 4단계에서 GitHub로 이 PC를 연결하세요.");
        return;
      }
      await rpc("collection.status");
      setReady(true);
      setStatus("이 PC의 로그인과 실행 중인 수집기를 확인했어요.");
    } catch (e) {
      setStatus(
        e instanceof ExtensionMissing
          ? "확장 프로그램이 응답하지 않아요. 설치 후 이 페이지를 새로고침하고 확장의 개인 검토함 주소를 확인해 주세요."
          : "SyncUp 앱에서 GitHub 연결과 수집기 실행을 확인해 주세요. 연결이 끝나면 다시 확인할 수 있어요.",
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, status, ready, check };
}

/** 스크린샷 위에 진갈색 선 네모와 왼쪽 위 번호 라벨을 얹는다 (위치는 그림 크기에 대한 %) */
function Mark({ n, left, top, width, height }: { n: number; left: string; top: string; width: string; height: string }) {
  return (
    <span aria-hidden className="absolute border-[1.5px] border-ink" style={{ left, top, width, height }}>
      <span className="absolute bottom-full -left-[1.5px] flex size-4 items-center justify-center bg-ink font-mono text-[10px] text-white">{n}</span>
    </span>
  );
}

/** 번호 있는 순서 목록. filled = 진갈색 칸(따라 하는 단계), outline = 빈 칸(선택 준비물) */
function NumberedList({ items, variant }: { items: ReactNode[]; variant: "filled" | "outline" }) {
  return (
    <ol className="flex flex-col gap-3 text-sm leading-[1.6] text-ink-body">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center font-mono text-[11px]",
              variant === "filled" ? "bg-ink text-white" : "border border-ink/24 text-ink",
            )}
          >
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function DownloadsSlide() {
  const downloads = desktopDownloads();
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        {downloads.map((d) => {
          const inner = (
            <>
              <span className="text-sm font-medium">{d.name}</span>
              <span className="text-xs text-ink-3">{d.detail}</span>
              {d.url ? (
                <span className="mt-3 text-[13px] underline">설치 파일 받기</span>
              ) : (
                <span className="mt-3 text-[13px] text-ink-3">설치 파일 배포 준비 중</span>
              )}
            </>
          );
          return d.url ? (
            <a key={d.name} href={d.url} rel="noreferrer" className={cn(card, "flex flex-col gap-1 p-4 text-ink hover:bg-blush/40")}>
              {inner}
            </a>
          ) : (
            <div key={d.name} className={cn(card, "flex flex-col gap-1 p-4 text-ink")}>
              {inner}
            </div>
          );
        })}
      </div>
      {downloads.every((d) => !d.url) && (
        <p role="status" className="text-[13px] text-ink">
          아직 설치 파일이 공개되지 않았어요. 다운로드가 준비된 뒤 다시 열어 계속해 주세요.
        </p>
      )}
      <p className="text-[13px] text-ink-2">이 PC에 맞는 파일 하나만 받으면 돼요. 압축을 풀고 SyncUp 앱을 여세요.</p>
    </>
  );
}

function ExtensionSlide() {
  return (
    <>
      <figure className="relative border border-card-border bg-white">
        <Image
          src="/installation/chrome-extensions-light.png"
          alt="Chrome 확장 관리 화면에서 오른쪽 위 개발자 모드와 왼쪽 위 압축해제된 확장 프로그램 로드 위치"
          width={3040}
          height={340}
          unoptimized
          className="block h-auto w-full"
        />
        <Mark n={1} left="88.5%" top="13%" width="11%" height="25%" />
        <Mark n={2} left="2%" top="54%" width="19.5%" height="40%" />
      </figure>
      <NumberedList
        variant="filled"
        items={[
          <>
            Chrome 주소창에 <code className={code}>chrome://extensions</code>를 열고 오른쪽 위 <b className={strong}>개발자 모드</b>를 켜세요
          </>,
          <>
            <b className={strong}>압축해제된 확장 프로그램 로드</b>를 누르고 SyncUp 앱이 열어 준 폴더를 고르세요
          </>,
        ]}
      />
    </>
  );
}

function ExtensionIdSlide() {
  return (
    <div className="flex flex-wrap items-start gap-5">
      <figure className="relative max-w-[360px] flex-[1_1_280px] border border-card-border bg-white">
        <Image
          src="/installation/chrome-syncup-id-light.png"
          alt="Chrome의 싱크업 SyncUp 카드에서 설명 아래 ID가 표시된 위치"
          width={1180}
          height={445}
          unoptimized
          className="block h-auto w-full"
        />
        <Mark n={3} left="21.5%" top="69%" width="60%" height="14%" />
      </figure>
      <ol className="flex flex-[1_1_240px] flex-col gap-3 text-sm leading-[1.6] text-ink-body">
        <li>
          싱크업 SyncUp 카드의 <b className={strong}>ID 32자리</b>를 복사하세요
        </li>
        <li>
          SyncUp 앱에 붙여 넣고 <b className={strong}>백업하고 이 PC에 설치</b>를 누르세요
        </li>
        <li>
          확장 팝업의 <b className={strong}>개인 검토함 주소</b>가 현재 사이트 주소인지 확인하고 이 페이지를 새로고침하세요
        </li>
        <li className="text-[13px] text-ink-3">화면 속 ID는 예시예요. 내 Chrome에 보이는 ID를 쓰세요.</li>
        <li className="text-xs text-ink-3">
          확장 v{release.version} · 기존 연결 설정은 앱이 백업합니다. 사용자 계정의 설정만 바꾸며 관리자 비밀번호를 요구하지 않아요.
        </li>
      </ol>
    </div>
  );
}

function GithubSlide({ onClose }: { onClose: () => void }) {
  const next = useSyncExternalStore(subscribe, installationNext, defaultNext);
  return (
    <div className={cn(card, "flex flex-col items-start gap-3 p-5")}>
      <Link href={next} onClick={onClose} className={slidePrimary}>
        {next.startsWith("/join/") ? "받은 초대 링크로 돌아가 참여하기" : "GitHub로 이 PC 연결하기"}
      </Link>
      <p className="text-[13px] leading-[1.6] text-ink-2">웹에 가입한 것과 같은 GitHub 계정을 고르세요. 초대 링크로 들어왔다면 연결 뒤 그 팀으로 돌아가요.</p>
    </div>
  );
}

function CheckSlide({ pc, onClose }: { pc: ReturnType<typeof usePcCheck>; onClose: () => void }) {
  return (
    <div className={cn(card, "flex flex-col items-start gap-3 p-5")}>
      <button type="button" onClick={pc.check} disabled={pc.busy} className={slidePrimary}>
        {pc.busy ? "연결 확인 중…" : "내 PC 연결 확인"}
      </button>
      <div role="status" className="min-h-5 text-[13px]">
        {pc.status && (
          <p className={cn("flex items-center gap-2", pc.ready ? "text-ok" : "text-ink-2")}>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", pc.ready ? "bg-ok" : "border border-faint")} />
            {pc.status}
          </p>
        )}
      </div>
      {pc.ready && (
        <Link href="/collect" onClick={onClose} className="text-[13px] font-medium text-ink underline">
          연결 완료 · 대화 수집으로 가기
        </Link>
      )}
    </div>
  );
}

function ClassifySlide() {
  return (
    <>
      <NumberedList
        variant="outline"
        items={[
          <>
            <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="underline">
              Ollama
            </a>
            를 설치하고 실행하세요
          </>,
          <>
            Ollama에서 <code className={code}>gemma4:e4b-it-qat</code> 모델을 준비하세요. 터미널에서는 <code className={code}>ollama pull gemma4:e4b-it-qat</code>로 받을 수 있어요.
          </>,
          <>SyncUp 앱의 ‘자동 분류 준비’에 본인의 OpenAI API 키를 넣고 수집기를 실행하세요. 키는 이번 실행 동안만 사용하고 파일에 저장하지 않아요.</>,
        ]}
      />
      <p className="text-[13px] leading-[1.6] text-ink-3">
        현재 버전은 PC의 개인정보 검사 모델과 개인 OpenAI API 키를 사용해요. 준비되지 않으면 분류가 대기하므로 설치 완료와 분류 준비를 구분해서 확인하세요.
      </p>
    </>
  );
}

function InstallDeck({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const pc = usePcCheck();
  const slide = SLIDES[step];
  return (
    <DialogFrame
      open
      onClose={onClose}
      title="PC 연결하기"
      counter={`${step + 1} / ${SLIDES.length}`}
      labelledBy={TITLE_ID}
      scrollKey={step}
      footer={
        <SlideFooter
          labels={SLIDES.map((s, i) => `${i + 1}단계 ${s.title}`)}
          index={step}
          onIndex={setStep}
          onFinish={onClose}
          finishLabel="완료"
        />
      }
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center bg-ink font-mono text-[13px] text-white">
          {step + 1}
        </span>
        <div className="flex flex-col gap-1">
          <h2 id={TITLE_ID} className="text-xl leading-[1.4] font-bold text-ink">
            {slide.title}
          </h2>
          <p className="text-sm leading-[1.6] text-ink-body">{slide.body}</p>
        </div>
      </div>
      {step === 0 && <DownloadsSlide />}
      {step === 1 && <ExtensionSlide />}
      {step === 2 && <ExtensionIdSlide />}
      {step === 3 && <GithubSlide onClose={onClose} />}
      {step === 4 && <CheckSlide pc={pc} onClose={onClose} />}
      {step === 5 && <ClassifySlide />}
    </DialogFrame>
  );
}

/** PC 연결하기 슬라이드. 닫혔다 다시 열면 1단계부터 시작한다 */
export function InstallSlidesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <InstallDeck onClose={onClose} /> : null;
}
