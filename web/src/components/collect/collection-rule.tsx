"use client";

import type { ExtStatus } from "@shared/bridge";
import { TURNS_PER_BATCH } from "@shared/batch";
import { fmtMDHM } from "@shared/format";
import { Switch } from "@/components/switch";
import { chip } from "@/components/ui/surface";
import { canSyncNow } from "@/lib/local-collector";
import { cn } from "@/lib/utils";
import { btnPrimary, panel, panelTitle, rowLine } from "./collect-ui";

// 수집 설정 탭의 "수집 기준" 카드: 고정 묶음 크기 · 다음 수집까지 눈금 · 싱크 맞추기 · 관련 대화만 수집 · 일시정지 · 종료 시각.
// status = 수집기에 닿았을 때만 있다 (없으면 눈금·종료 시각 줄을 숨기고 스위치를 잠근다)
export function CollectionRule({ status, syncing, onSync, onPausedChange }: {
  status: ExtStatus | null;
  syncing: boolean;
  onSync: () => void;
  onPausedChange: (paused: boolean) => void;
}) {
  const turns = status ? (status.nextBatchTurns ?? status.bufferedTurns) : 0;
  return (
    <section className={cn(panel, "flex flex-col")} aria-labelledby="collection-rule-title">
      <div className="space-y-3 p-5">
        <h2 id="collection-rule-title" className={panelTitle}>
          수집 기준
        </h2>
        {/* 묶음 크기는 팀 고정값 (shared/batch.ts). 수집기에 다른 값이 남아 있으면 확장이 기본값으로 되돌린다.
            피그마는 −/+ 칸이지만 고를 수 없는 값이라 숫자 칸만 둔다 */}
        <p className="flex flex-wrap items-center gap-2.5 text-[15px] leading-[1.5] font-medium">
          대화
          <span className="border border-card-border px-3 py-1.5 text-base" title="팀 고정값이에요">
            {TURNS_PER_BATCH}
          </span>
          회마다 자동으로 수집해 승인함에 올려요
        </p>
        {status && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-surface-soft px-4 py-3 text-sm">
            <TickMeter turns={turns} />
            <span>
              다음 수집까지 대화 <b className="font-medium tabular-nums">{turns}</b>/{TURNS_PER_BATCH}회
            </span>
            <button className={cn(btnPrimary, "ml-auto h-8 px-3 text-[13px]")} disabled={syncing || !canSyncNow(status)} onClick={onSync}>
              {syncing ? "맞추는 중…" : "싱크 맞추기"}
            </button>
          </div>
        )}
      </div>
      <SettingRow
        title="이 팀 프로젝트와 관련된 대화만 수집"
        desc="자동 수집은 켜 둔 동안의 새 대화를 읽어요. 프로젝트 대화를 할 때만 켜 두세요. 프로젝트와 관련된 내용만 내 검토함에 후보로 보여 주고, 팀에는 승인한 카드만 공유돼요."
      >
        <span className={cn(chip, "bg-ok-soft text-ok")}>항상 켜짐</span>
      </SettingRow>
      <SettingRow title="수집 일시정지" desc="일시중지하면 새 수집과 AI 요청을 멈춥니다. 이미 승인한 카드의 전송은 계속됩니다.">
        <Switch checked={status ? !status.autoCollect : false} disabled={!status} onChange={onPausedChange} label="수집 일시정지" />
      </SettingRow>
      {status && (
        <p className={cn(rowLine, "px-5 py-3 text-xs leading-[1.5] text-muted-foreground")}>
          수집 종료 시각 {fmtMDHM(new Date(status.endsAt))} — 남은 대화는 보관하고 수집과 AI 요청을 멈춰요.
        </p>
      )}
    </section>
  );
}

// 눈금 계기: 묶음 크기(TURNS_PER_BATCH)만큼 칸을 두고, 지금 쌓인 대화 수만큼 채운다. 옆의 글자가 같은 값을 말하므로 화면 읽기에서는 숨긴다
function TickMeter({ turns }: { turns: number }) {
  const filled = Math.min(Math.max(Math.floor(turns), 0), TURNS_PER_BATCH);
  return (
    <div aria-hidden className="flex gap-1">
      {Array.from({ length: TURNS_PER_BATCH }, (_, i) => (
        <span key={i} className={cn("size-3 shrink-0 border", i < filled ? "border-ink bg-ink" : "border-ink/25")} />
      ))}
    </div>
  );
}

function SettingRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className={cn(rowLine, "flex items-center gap-4 px-5 py-4")}>
      <div className="min-w-0 flex-1 leading-[1.5]">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground break-keep">{desc}</p>
      </div>
      {children}
    </div>
  );
}
