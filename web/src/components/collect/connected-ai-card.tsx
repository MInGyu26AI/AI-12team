"use client";

import Link from "next/link";
import type { ExtStatus } from "@shared/bridge";
import { fmtMDHM } from "@shared/format";
import { buttonSoft, card, chip } from "@/components/ui/surface";
import type { CollectorLink } from "@/lib/local-collector";
import { cn } from "@/lib/utils";

// 연결 상태 탭의 "연결된 AI" 카드 (피그마 3번 152:114 그대로). status = 수집기에 닿았을 때만 있다
export function ConnectedAiCard({ link, status: st }: { link: CollectorLink; status: ExtStatus | null }) {
  const connected = !!st;
  return (
    <section className={cn(card, "p-5")} aria-labelledby="connected-ai-title">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <h2 id="connected-ai-title" className="text-base leading-[1.5] font-bold">
          연결된 AI
        </h2>
        {link === "connected" ? (
          <span className={cn(chip, "bg-ok-soft text-ok")}>로컬 수집기 연결됨</span>
        ) : link === "extension-missing" ? (
          <Link href="/install" className={cn(chip, "bg-warn-soft text-warn hover:underline")}>
            브라우저 확장 설치 필요 →
          </Link>
        ) : link === "collector-off" ? (
          <span className={cn(chip, "bg-warn-soft text-warn")}>로컬 수집기 꺼짐 · 수집기를 실행해 주세요</span>
        ) : (
          <span className="text-xs text-muted-foreground">확장 확인 중…</span>
        )}
      </div>
      <AiRow
        name="ChatGPT 웹"
        detail={
          st
            ? st.lastCollectedAt
              ? `마지막 수집 ${fmtMDHM(new Date(st.lastCollectedAt))}`
              : "아직 수집한 대화가 없어요"
            : link === "collector-off"
              ? "확장은 연결됐어요. 로컬 수집기를 실행하면 수집을 시작해요"
              : "브라우저 확장을 설치하면 연결돼요"
        }
        on={connected}
        action={
          connected ? (
            <ConnectedChip />
          ) : link === "collector-off" ? null : (
            <Link href="/install" className={buttonSoft}>
              연결하기
            </Link>
          )
        }
      />
      <AiRow
        name="Codex·Claude Code"
        detail={
          st && !st.browserOnly
            ? "로컬 수집기가 선택한 프로젝트에서 완료된 새 발화를 모아요"
            : st ? "현재 앱은 브라우저 대화만 수집해요"
            : link === "collector-off"
              ? "로컬 수집기가 꺼져 있어요. 수집기를 실행해 주세요"
              : "로컬 수집기를 실행하면 연결돼요"
        }
        on={!!st && !st.browserOnly}
        action={st && !st.browserOnly ? <ConnectedChip /> : null}
      />
      <AiRow name="Claude 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} />
      <AiRow name="Gemini 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} />
    </section>
  );
}

// 피그마 AI 줄: 위 구분선 · 위아래 12 · 점 10px(연결 초록 / 미연결 베이지) · 이름 15px · 설명 12px
function AiRow({ name, detail, on, action }: { name: string; detail: string; on: boolean; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-card-border py-3">
      <span className={cn("size-2.5 shrink-0 rounded-full", on ? "bg-ok" : "bg-[#d6c9b5]")} />
      <div className="min-w-0 flex-1 leading-[1.5]">
        <p className="text-[15px] font-medium">{name}</p>
        <p className="text-xs text-muted-foreground break-keep">{detail}</p>
      </div>
      {action}
    </div>
  );
}

const SoonChip = () => <span className={cn(chip, "bg-muted text-muted-foreground")}>곧 지원</span>;
const ConnectedChip = () => <span className={cn(chip, "bg-ok-soft text-ok")}>연결됨</span>;
