import type { Metadata } from "next";
import Link from "next/link";
import { Download, FolderOpen, Puzzle, RefreshCw, Server, Settings, ShieldCheck, ToggleRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import release from "@/lib/extension-release.json";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "확장 프로그램 설치 · 싱크업",
  description: "싱크업 크롬 확장 프로그램을 내려받아 개발자 모드로 설치하는 방법",
};

const STEPS = [
  {
    icon: Download,
    title: "zip 내려받고 압축 풀기",
    body: (
      <>
        위 버튼으로 받은 <code>syncup-extension.zip</code>을 마우스 오른쪽 버튼 → <b>압축 풀기</b>. zip 파일 그대로는 설치되지
        않아요. 풀린 폴더는 지우지 말고 그대로 두세요.
      </>
    ),
  },
  {
    icon: ToggleRight,
    title: "크롬에서 개발자 모드 켜기",
    body: (
      <>
        주소창에 <code>chrome://extensions</code> 입력 → 오른쪽 위 <b>개발자 모드</b> 스위치를 켜요.
      </>
    ),
  },
  {
    icon: FolderOpen,
    title: "압축해제된 확장 프로그램 로드",
    body: (
      <>
        <b>압축해제된 확장 프로그램 로드</b> → 압축을 푼 폴더(안에 <code>manifest.json</code>이 보이는 폴더)를 선택해요.
      </>
    ),
  },
  {
    icon: Puzzle,
    title: "툴바에 고정",
    body: <>주소창 오른쪽 퍼즐 아이콘 → ‘싱크업 SyncUp’ 옆 핀(📌)을 눌러 고정해요.</>,
  },
  {
    icon: Server,
    title: "로컬 수집기 연결",
    body: (
      <>
        확장은 이 컴퓨터의 로컬 수집기를 거쳐서만 동작해요. 저장소의 <code>docs/running.md</code>에 따라 수집기를 먼저 실행하고,
        확장 ID로 Native Messaging 설정(<code>collector/prepare_native.py</code>)을 만들어 크롬에 등록해요.
      </>
    ),
  },
  {
    icon: Settings,
    title: "처음 설정",
    body: (
      <>
        싱크업 아이콘 → 로컬 수집기가 알려 준 등록된 팀과 사용자를 확인하고 프로젝트 주제를 입력해 저장해요. 승인함 주소는 이
        사이트로 미리 채워져 있어요. 이미 열어 둔 ChatGPT 탭은 새로고침해 주세요.
      </>
    ),
  },
];

export default function InstallPage() {
  const built = new Date(release.builtAt).toLocaleDateString("ko-KR");
  return (
    <div className="mx-auto max-w-content space-y-gap-section px-gutter py-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">확장 프로그램 설치</h1>
        <p className="text-sm text-muted-foreground break-keep">
          프로젝트 대화만 가져와 결정·할 일·조사 후보를 내 승인함에 모아 주고, 내가 승인한 것만 팀에 공유하는 크롬 확장 프로그램이에요.
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold">싱크업 SyncUp v{release.version}</p>
          <p className="text-sm text-muted-foreground">
            크롬 · zip {release.sizeKB}KB · {built} 빌드
          </p>
        </div>
        <a href="/syncup-extension.zip" download className={cn(buttonVariants({ size: "lg" }), "h-10 bg-brand px-4 hover:bg-brand-hover")}>
          <Download />
          확장 프로그램 내려받기
        </a>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">설치 방법</h2>
        <ol className="space-y-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="flex gap-3 rounded-xl border bg-card p-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-tag-decision-soft text-sm font-bold text-tag-decision">
                {i + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-1.5 font-medium">
                  <Icon className="size-4 text-muted-foreground" />
                  {title}
                </p>
                <p className="text-sm text-muted-foreground break-keep [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-foreground">
                  {body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-xl border bg-card p-4 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <RefreshCw className="size-4 text-muted-foreground" />
            새 버전으로 업데이트
          </p>
          <p className="text-muted-foreground break-keep">
            새 zip을 받아 <b>예전에 풀었던 폴더에 덮어쓰기</b>로 압축을 푼 뒤, <code className="rounded bg-muted px-1">chrome://extensions</code>
            에서 싱크업의 ↻(새로고침)을 누르고 ChatGPT 탭도 새로고침해요. 설정과 검토 대기 카드는 그대로 남아요.
          </p>
          <p className="text-muted-foreground break-keep">
            크롬을 켤 때 “개발자 모드 확장 프로그램” 경고가 뜨면 <b>닫기</b>를 누르면 계속 쓸 수 있어요.
          </p>
        </div>
        <div className="space-y-2 rounded-xl border bg-card p-4 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" />
            무엇을 수집하나요?
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground break-keep">
            <li>자동 수집을 켠 동안 chatgpt.com 에서 새로 끝난 대화만 읽어요.</li>
            <li>팀에는 내가 승인한 카드만 올라가요. 외부 AI로 보내기 전에 전화번호 같은 민감정보는 가려요.</li>
            <li>
              팀에는 <Link href="/review" className="underline">승인함</Link>에서 내가 체크해서 공유한 카드만 올라가요.
            </li>
          </ul>
        </div>
      </section>

      <p className="text-sm text-muted-foreground">
        설치가 됐는지는 <Link href="/collect" className="underline">대화 수집</Link>에서 “로컬 수집기 연결됨” 표시가 보이는지로
        확인할 수 있어요.
      </p>
    </div>
  );
}
