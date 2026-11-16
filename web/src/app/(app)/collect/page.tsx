"use client";

import { Suspense, startTransition, useOptimistic, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { TURNS_PER_BATCH } from "@shared/batch";
import { RepoLinkRow } from "@/components/board/repo-status";
import { CollectionRule } from "@/components/collect/collection-rule";
import { CollectionSettings } from "@/components/collect/collection-settings";
import { CollectTabList, CollectTabPanel, parseCollectTab, type CollectTab } from "@/components/collect/collect-tabs";
import { ConnectedAiCard } from "@/components/collect/connected-ai-card";
import { ImportTab } from "@/components/collect/import-tab";
import { PcCard } from "@/components/collect/pc-card";
import { PcConnectPanel } from "@/components/collect/pc-connect-panel";
import { RecentBatches } from "@/components/collect/recent-batches";
import { ExtensionMissingDialog } from "@/components/extension-missing-dialog";
import { PageTitle } from "@/components/page-title";
import { USE_MOCK } from "@/lib/api";
import { collectorLink, useLocalCollector } from "@/lib/local-collector";
import { syncNowErrorNotice, syncNowSummary } from "@/lib/rpc";
import { useRepo } from "@/lib/use-repo";

// 대시보드 안의 대화 수집 (시안 "대화 수집 (대시보드 안)"). 바깥 여백·너비는 대시보드 틀이 정한다.
// 이 PC가 연결돼 있으면 탭 4개(연결 상태 · 수집 설정 · 직접 가져오기 · 최근 수집), 아니면 탭 대신 'PC 연결' 안내를 보인다.
// 고른 탭은 주소의 ?tab= 에 두어 사이드바 등 다른 곳에서 바로 열 수 있다 (기본 connection).
// 안쪽 카드의 모서리는 시안대로 0: 이미 있던 카드(section)는 12px 이므로 여기서 한꺼번에 덮는다
// 바깥 여백·너비는 대시보드(팀) 화면과 같게
const ROOT = "mx-auto max-w-[1120px] space-y-6 px-gutter py-8 md:px-8 [&_section]:rounded-none";

const Title = () => <PageTitle display="Bring your chats in." title="대화 수집" />;

// useSearchParams 는 Suspense 안에서만 쓴다 (Cache Components 사전 렌더링)
export default function CollectPage() {
  return (
    <Suspense
      fallback={
        <div className={ROOT}>
          <Title />
        </div>
      }
    >
      <CollectView />
    </Suspense>
  );
}

function CollectView() {
  const collector = useLocalCollector();
  const repo = useRepo();
  const st = collector.available ? collector.status : null; // 수집기에 닿았을 때만 상태를 쓴다
  const link = collectorLink(collector); // 확장 없음과 로컬 수집기 꺼짐을 나눠 안내한다
  const pendingIds = new Set(collector.cards.map((c) => c.id));
  const [syncing, setSyncing] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  // 탭: 주소(?tab=)가 기준이고, 눌렀을 때는 주소가 바뀔 때까지 고른 탭을 먼저 보여 준다
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useOptimistic(parseCollectTab(searchParams.get("tab")));
  const selectTab = (next: CollectTab) =>
    startTransition(() => {
      setTab(next);
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });

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

  // 다시 확인: 수집기 상태를 지금 새로 읽는다 (예시 모드는 수집기에 요청하지 않는다)
  const recheck = async () => {
    if (USE_MOCK) {
      toast.info("예시 모드에서는 실제 수집기에 요청하지 않습니다.");
      return;
    }
    setRechecking(true);
    try {
      await collector.refresh();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className={ROOT}>
      <Title />
      {collector.error && (
        <p role="alert" className="text-sm break-keep text-destructive">
          {collector.error}
        </p>
      )}
      <ExtensionMissingDialog missing={collector.extensionMissing} />

      {/* 예시 모드는 수집기를 늘 쓸 수 있는 것으로 보고 탭을 보인다 (collectorLink 는 이때 설치 안내용으로 extension-missing 을 돌려준다) */}
      {USE_MOCK || link === "connected" ? (
        <>
          <CollectTabList value={tab} onChange={selectTab} />
          <CollectTabPanel tab={tab}>
            {tab === "connection" && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] items-start gap-4">
                <PcCard link={link} status={st} mock={USE_MOCK} rechecking={rechecking} onRecheck={recheck} />
                <ConnectedAiCard link={link} status={st} />
              </div>
            )}

            {tab === "settings" && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] items-start gap-4">
                {/* 승인 대상 팀 · 프로젝트 주제 · 수집 종료 시각 (피그마에 없는 기존 설정) + 레포 연결 상태 */}
                {st && (
                  <CollectionSettings status={st} onChange={collector.updateSettings}>
                    {repo.status && <RepoLinkRow status={repo.status} />}
                  </CollectionSettings>
                )}
                <CollectionRule
                  status={st}
                  syncing={syncing}
                  onSync={syncNow}
                  onPausedChange={(paused) => collector.updateSettings({ autoCollect: !paused })}
                />
              </div>
            )}

            {tab === "import" && <ImportTab connected={!!st} />}

            {tab === "recent" && (
              <RecentBatches
                batches={st ? st.recent : null}
                pendingIds={pendingIds}
                emptyText={st ? `ChatGPT에서 대화를 ${TURNS_PER_BATCH}회 나누면 여기에 쌓여요.` : "브라우저 확장을 연결하면 수집 기록이 보여요."}
              />
            )}
          </CollectTabPanel>
        </>
      ) : link === "checking" ? (
        <p role="status" className="text-sm text-muted-foreground">
          이 PC의 연결을 확인하고 있어요…
        </p>
      ) : (
        <PcConnectPanel link={link} rechecking={rechecking} onRecheck={recheck} />
      )}
    </div>
  );
}
