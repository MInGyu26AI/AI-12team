"use client";

import { useState } from "react";
import { InstallSlidesDialog } from "@/components/dashboard/install-slides";
import type { CollectorLink } from "@/lib/local-collector";
import { cn } from "@/lib/utils";
import { btnOutline, btnPrimary, panel } from "./collect-ui";

const STEPS = [
  { title: "SyncUp 앱 받기", note: "Mac·Windows 중 이 PC에 맞는 파일" },
  { title: "Chrome에 확장 올리기", note: "앱이 열어 준 폴더를 불러와요" },
  { title: "GitHub로 이 PC 연결", note: "웹 가입과 같은 계정으로" },
];

// 이 PC가 연결되지 않았을 때 탭 대신 보이는 안내 (확장 없음 · 로컬 수집기 꺼짐).
// 'PC 연결하기' = 설치 안내 슬라이드, '다시 확인' = 수집기 상태를 지금 다시 읽기. 연결되면 화면이 스스로 탭으로 바뀐다
export function PcConnectPanel({ link, rechecking, onRecheck }: {
  link: Exclude<CollectorLink, "connected" | "checking">;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const [slides, setSlides] = useState(false);
  return (
    <section className={cn(panel, "flex flex-col gap-6 p-5 sm:p-8")} aria-labelledby="pc-connect-title">
      <div className="space-y-1">
        <h2 id="pc-connect-title" className="text-xl leading-[1.4] font-bold break-keep">
          대화를 모으려면 이 PC를 먼저 연결하세요
        </h2>
        <p className="text-sm leading-[1.6] text-ink-body break-keep">
          연결하면 여기에서 연결 상태, 수집 설정, 직접 가져오기, 최근 수집을 볼 수 있어요. 붙여넣기도 이 PC의 수집기를 거쳐요.
        </p>
      </div>
      <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3 border border-card-border p-4">
            <span aria-hidden className="flex size-6 shrink-0 items-center justify-center bg-ink font-mono text-xs text-white">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium break-keep">{step.title}</span>
              <span className="text-xs leading-[1.5] text-muted-foreground break-keep">{step.note}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} onClick={() => setSlides(true)}>
          PC 연결하기
        </button>
        <button type="button" className={btnOutline} disabled={rechecking} onClick={onRecheck}>
          {rechecking ? "확인 중…" : "이미 설치했어요 · 다시 확인"}
        </button>
      </div>
      <p role="status" className="flex items-center gap-2 text-[13px] text-ink-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full border border-card-border-personal" />
        {link === "extension-missing" ? "지금은 브라우저 확장이 응답하지 않아요" : "확장은 응답해요. SyncUp 앱의 수집기가 꺼져 있어요"}
      </p>
      <InstallSlidesDialog open={slides} onClose={() => setSlides(false)} />
    </section>
  );
}
