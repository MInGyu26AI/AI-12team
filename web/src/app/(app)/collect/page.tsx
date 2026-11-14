"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { TURNS_PER_BATCH } from "@shared/batch";
import { fmtMDHM } from "@shared/format";
import { RepoLinkRow } from "@/components/board/repo-status";
import { CollectionSettings } from "@/components/collect/collection-settings";
import { RecentBatches } from "@/components/collect/recent-batches";
import { ExtensionMissingDialog } from "@/components/extension-missing-dialog";
import { Switch } from "@/components/switch";
import { canSyncNow, useLocalCollector } from "@/lib/local-collector";
import { syncNowErrorNotice, syncNowSummary } from "@/lib/rpc";
import { useRepo } from "@/lib/use-repo";
import { cn } from "@/lib/utils";

// 피그마 3번: 대화 자동 수집 (브라우저 확장 상태·수집 기준·최근 수집)
export default function CollectPage() {
  const collector = useLocalCollector();
  const repo = useRepo();
  const st = collector.status;
  const connected = collector.available && !!st;
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
    <div className="mx-auto max-w-content space-y-6 px-gutter py-10">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">대화 자동 수집</h1>
        <p className="text-muted-foreground break-keep">
          브라우저 확장이 ChatGPT 웹 대화를 모아 승인함으로 보내요. 팀에 바로 올라가지 않고, 내가 승인한 것만 공유돼요.
        </p>
      </div>
      {collector.error && <p role="alert">{collector.error}</p>}
      <ExtensionMissingDialog missing={collector.extensionMissing} />
      {connected && <CollectionSettings status={st} onChange={collector.updateSettings} />}
      {connected && repo.status && (
        <section className="rounded-xl border bg-card px-6 py-4" aria-label="레포 연결">
          <RepoLinkRow status={repo.status} />
        </section>
      )}

      {/* 연결된 AI */}
      <section className="rounded-xl border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-4">
          <h2 className="font-semibold">연결된 AI</h2>
          {connected ? (
            <span className="rounded-full bg-ok-soft px-3 py-1 text-xs font-semibold text-ok">로컬 수집기 연결됨</span>
          ) : collector.checked ? (
            <Link href="/install" className="rounded-full bg-warn-soft px-3 py-1 text-xs font-semibold text-warn">
              브라우저 확장 설치 필요 →
            </Link>
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
              : "브라우저 확장을 설치하면 연결돼요"
          }
          on={connected}
          action={
            connected ? (
              <ConnectedChip />
            ) : (
              <Link href="/install" className="rounded-lg bg-brand-soft px-4 py-2 text-sm font-semibold text-brand">
                연결하기
              </Link>
            )
          }
        />
        <AiRow
          name="Codex·Claude Code"
          detail={connected ? "로컬 수집기가 선택한 프로젝트에서 완료된 새 발화를 모아요" : "로컬 수집기를 실행하면 연결돼요"}
          on={connected}
          action={connected ? <ConnectedChip /> : null}
        />
        <AiRow name="Claude 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} />
        <AiRow name="Gemini 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} last />
      </section>

      {/* 수집 기준 */}
      <section className="space-y-5 rounded-xl border bg-card p-6">
        <h2 className="font-semibold">수집 기준</h2>
        {/* 묶음 크기는 팀 고정값 (shared/batch.ts). 수집기에 다른 값이 남아 있으면 확장이 기본값으로 되돌린다 */}
        <p>
          대화 <b className="text-lg text-brand">{TURNS_PER_BATCH}</b>회마다 자동으로 수집해 승인함에 올려요
        </p>
        {connected && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">
            <span>
              다음 수집까지 대화 <b>{st.nextBatchTurns ?? st.bufferedTurns}</b>/{TURNS_PER_BATCH}회
            </span>
            <button
              className="ml-auto rounded-md border bg-background px-2.5 py-1 text-xs font-medium disabled:opacity-40"
              disabled={syncing || !canSyncNow(st)}
              onClick={syncNow}
            >
              {syncing ? "맞추는 중…" : "싱크 맞추기"}
            </button>
          </div>
        )}
        <div>
          <p className="font-medium">프로젝트 대화만 가져오고, 내가 승인한 것만 팀에 공유</p>
          <p className="text-sm text-muted-foreground break-keep">
            자동 수집은 켜 둔 동안의 새 대화를 읽어요. 프로젝트 대화를 할 때만 켜 두세요. 프로젝트와 관련된 내용만 내 검토함에 후보로 보여 주고, 팀에는 승인한 카드만 공유돼요.
          </p>
        </div>
        <ToggleRow
          title="수집 일시정지"
          desc="일시중지하면 새 수집과 AI 요청을 멈춥니다. 이미 승인한 카드의 전송은 계속됩니다."
          checked={connected ? !st.autoCollect : false}
          disabled={!connected}
          onChange={(paused) => collector.updateSettings({ autoCollect: !paused })}
        />
        {connected && (
          <p className="text-sm text-muted-foreground">
            수집 종료 시각 {fmtMDHM(new Date(st.endsAt))} — 남은 대화는 보관하고 수집과 AI 요청을 멈춰요.
          </p>
        )}
      </section>

      <RecentBatches
        batches={connected ? st.recent : null}
        pendingIds={pendingIds}
        emptyText={connected ? `ChatGPT에서 대화를 ${TURNS_PER_BATCH}회 나누면 여기에 쌓여요.` : "브라우저 확장을 연결하면 수집 기록이 보여요."}
      />

      <p className="text-sm text-muted-foreground">
        확장 프로그램을 쓸 수 없나요?{" "}
        <Link href="/collect/paste" className="font-semibold text-brand hover:underline">
          대화 직접 붙여넣기
        </Link>
      </p>
    </div>
  );
}

function AiRow({ name, detail, on, action, last }: { name: string; detail: string; on: boolean; action: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 py-4", !last && "border-b")}>
      <span className={cn("size-2.5 shrink-0 rounded-full", on ? "bg-ok" : "bg-gray-300")} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

const SoonChip = () => <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">곧 지원</span>;
const ConnectedChip = () => <span className="rounded-full bg-ok-soft px-3 py-1 text-sm font-semibold text-ok">연결됨</span>;

function ToggleRow(props: { title: string; desc: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-muted-foreground break-keep">{props.desc}</p>
      </div>
      <Switch checked={props.checked} disabled={props.disabled} onChange={props.onChange} label={props.title} />
    </div>
  );
}
