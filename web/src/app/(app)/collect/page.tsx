"use client";

import { DocumentConnections } from "@/components/collect/document-connections";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { TURNS_PER_BATCH } from "@shared/batch";
import { fmtMDHM } from "@shared/format";
import { RepoLinkRow } from "@/components/board/repo-status";
import { CollectionSettings } from "@/components/collect/collection-settings";
import { FileUploadCard } from "@/components/collect/file-upload-card";
import { RecentBatches } from "@/components/collect/recent-batches";
import { ExtensionMissingDialog } from "@/components/extension-missing-dialog";
import { PageTitle } from "@/components/page-title";
import { Switch } from "@/components/switch";
import { buttonOutline, buttonSoft, card, chip } from "@/components/ui/surface";
import { canSyncNow, collectorLink, useLocalCollector } from "@/lib/local-collector";
import { syncNowErrorNotice, syncNowSummary } from "@/lib/rpc";
import { useRepo } from "@/lib/use-repo";
import { cn } from "@/lib/utils";

// 피그마 3번: 프로젝트 대화 수집 (152:114). 연결된 AI · 수집 기준 · 최근 수집. 팀·주제·종료 시각 설정과 레포 연결 줄은 피그마에 없는 기존 기능이라 같은 카드 모양으로 둔다
export default function CollectPage() {
  const collector = useLocalCollector();
  const repo = useRepo();
  const st = collector.status;
  const connected = collector.available && !!st;
  const link = collectorLink(collector); // 확장 없음과 로컬 수집기 꺼짐을 나눠 안내한다
  const pendingIds = new Set(collector.cards.map((c) => c.id));
  const [syncing, setSyncing] = useState(false);

  // 싱크 맞추기: 프로젝트 동기화(켜져 있을 때)와 쌓인 대화 분류를 한 번에 하고 결과를 짧게 알린다
  const syncNow = async () => {
    setSyncing(true);
    try {
      const { tone, text } = syncNowSummary(await collector.syncNow("button"));
      toast[tone](text);
    } catch (error) {
      const { tone, text } = syncNowErrorNotice(error);
      toast[tone](text);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mx-auto max-w-[860px] space-y-[18px] px-gutter py-10">
      <PageTitle display="Bring your chats in." title="프로젝트 대화 수집">
        브라우저 확장이 ChatGPT 프로젝트 대화를 모아 승인함으로 보내요. 팀에 바로 올라가지 않고, 내가 승인한 것만 공유돼요.
      </PageTitle>
      {collector.error && <p role="alert">{collector.error}</p>}
      <ExtensionMissingDialog missing={collector.extensionMissing} />

      {/* 연결된 AI */}
      <section className={cn(card, "p-5")}>
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
          <h2 className="text-base leading-[1.5] font-bold">연결된 AI</h2>
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
            connected
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
            connected && !st.browserOnly
              ? "로컬 수집기가 선택한 프로젝트에서 완료된 새 발화를 모아요"
              : connected ? "현재 앱은 브라우저 대화만 수집해요"
              : link === "collector-off"
                ? "로컬 수집기가 꺼져 있어요. 수집기를 실행해 주세요"
                : "로컬 수집기를 실행하면 연결돼요"
          }
          on={connected && !st.browserOnly}
          action={connected && !st.browserOnly ? <ConnectedChip /> : null}
        />
        <AiRow name="Claude 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} />
        <AiRow name="Gemini 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} />
      </section>

      {/* 승인 대상 팀 · 프로젝트 주제 · 수집 종료 시각 (피그마에 없는 기존 설정) + 레포 연결 상태 */}
      {connected && (
        <CollectionSettings status={st} onChange={collector.updateSettings}>
          {repo.status && <RepoLinkRow status={repo.status} />}
        </CollectionSettings>
      )}

      {/* 수집 기준 */}
      <section className={cn(card, "space-y-3.5 p-5")}>
        <h2 className="text-base leading-[1.5] font-bold">수집 기준</h2>
        {/* 묶음 크기는 팀 고정값 (shared/batch.ts). 수집기에 다른 값이 남아 있으면 확장이 기본값으로 되돌린다.
            피그마는 −/+ 칸이지만 고를 수 없는 값이라 숫자 칸만 둔다 */}
        <p className="flex flex-wrap items-center gap-2.5 text-[15px] leading-[1.5] font-medium">
          대화
          <span className="rounded-md border border-card-border px-3 py-1.5 text-base" title="팀 고정값이에요">
            {TURNS_PER_BATCH}
          </span>
          회마다 자동으로 수집해 승인함에 올려요
        </p>
        {connected && (
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface-soft px-3 py-2 text-sm">
            <span>
              다음 수집까지 대화 <b className="font-medium">{st.nextBatchTurns ?? st.bufferedTurns}</b>/{TURNS_PER_BATCH}회
            </span>
            <button className={cn(buttonOutline, "ml-auto px-3 py-1 text-xs")} disabled={syncing || !canSyncNow(st)} onClick={syncNow}>
              {syncing ? "맞추는 중…" : "싱크 맞추기"}
            </button>
          </div>
        )}
        <SettingRow
          title="이 팀 프로젝트와 관련된 대화만 수집"
          desc="자동 수집은 켜 둔 동안의 새 대화를 읽어요. 프로젝트 대화를 할 때만 켜 두세요. 프로젝트와 관련된 내용만 내 검토함에 후보로 보여 주고, 팀에는 승인한 카드만 공유돼요."
        >
          <span className={cn(chip, "bg-ok-soft text-ok")}>항상 켜짐</span>
        </SettingRow>
        <SettingRow title="수집 일시정지" desc="일시중지하면 새 수집과 AI 요청을 멈춥니다. 이미 승인한 카드의 전송은 계속됩니다.">
          <Switch
            checked={connected ? !st.autoCollect : false}
            disabled={!connected}
            onChange={(paused) => collector.updateSettings({ autoCollect: !paused })}
            label="수집 일시정지"
          />
        </SettingRow>
        {connected && (
          <p className="text-xs leading-[1.5] text-muted-foreground">
            수집 종료 시각 {fmtMDHM(new Date(st.endsAt))} — 남은 대화는 보관하고 수집과 AI 요청을 멈춰요.
          </p>
        )}
      </section>

      <FileUploadCard />
      <DocumentConnections connected={connected} />

      <RecentBatches
        batches={connected ? st.recent : null}
        pendingIds={pendingIds}
        emptyText={connected ? `ChatGPT에서 대화를 ${TURNS_PER_BATCH}회 나누면 여기에 쌓여요.` : "브라우저 확장을 연결하면 수집 기록이 보여요."}
      />

      <p className="text-sm text-muted-foreground">
        카카오톡 대화나 텍스트를 가져오려면{" "}
        <Link href="/collect/paste" className="font-semibold text-brand hover:underline">
          대화 직접 붙여넣기
        </Link>
      </p>
    </div>
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

function SettingRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 leading-[1.5]">
        <p className="text-[15px] font-medium">{title}</p>
        <p className="text-xs text-muted-foreground break-keep">{desc}</p>
      </div>
      {children}
    </div>
  );
}
