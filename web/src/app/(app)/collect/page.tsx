"use client";

import Link from "next/link";
import { Minus, Plus } from "lucide-react";
import { MAX_TURNS_PER_BATCH, TURNS_PER_BATCH } from "@shared/batch";
import { fmtMDHM } from "@shared/format";
import { CollectionSettings } from "@/components/collect/collection-settings";
import { buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/switch";
import { useLocalCollector } from "@/lib/local-collector";
import { cn } from "@/lib/utils";

// 피그마 3번: 대화 자동 수집 (브라우저 확장 상태·수집 기준·최근 수집)
export default function CollectPage() {
  const ext = useLocalCollector();
  const st = ext.status;
  const connected = ext.available && !!st;
  const pendingIds = new Set(ext.cards.map((c) => c.id));

  return (
    <div className="mx-auto max-w-content space-y-6 px-gutter py-10">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">대화 자동 수집</h1>
        <p className="text-muted-foreground break-keep">
          브라우저 확장이 ChatGPT 웹 대화를 모아 승인함으로 보내요. 팀에 바로 올라가지 않고, 내가 승인한 것만 공유돼요.
        </p>
      </div>
      {ext.error && <p role="alert">{ext.error}</p>}
      {connected && <CollectionSettings status={st} onChange={ext.updateSettings} />}

      {/* 연결된 AI */}
      <section className="rounded-xl border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-4">
          <h2 className="font-semibold">연결된 AI</h2>
          {connected ? (
            <span className="rounded-full bg-ok-soft px-3 py-1 text-xs font-semibold text-ok">브라우저 확장 v{st.version} 연결됨</span>
          ) : ext.checked ? (
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
              <span className="rounded-full bg-ok-soft px-3 py-1 text-sm font-semibold text-ok">연결됨</span>
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
          action={connected ? <span className="rounded-full bg-ok-soft px-3 py-1 text-sm font-semibold text-ok">연결됨</span> : null}
        />
        <AiRow name="Claude 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} />
        <AiRow name="Gemini 웹" detail="지원 예정이에요" on={false} action={<SoonChip />} last />
      </section>

      {/* 수집 기준 */}
      <section className="space-y-5 rounded-xl border bg-card p-6">
        <h2 className="font-semibold">수집 기준</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span>대화</span>
          <span className="flex items-center rounded-lg border">
            <button
              className="px-3 py-2 text-muted-foreground disabled:opacity-40"
              disabled={!connected || st.turnsPerBatch <= 1}
              onClick={() => st && ext.updateSettings({ turnsPerBatch: st.turnsPerBatch - 1 })}
              aria-label="줄이기"
            >
              <Minus className="size-4" />
            </button>
            <b className="w-8 text-center text-lg text-brand">{st?.turnsPerBatch ?? TURNS_PER_BATCH}</b>
            <button
              className="px-3 py-2 text-muted-foreground disabled:opacity-40"
              disabled={!connected || st.turnsPerBatch >= MAX_TURNS_PER_BATCH}
              onClick={() => st && ext.updateSettings({ turnsPerBatch: st.turnsPerBatch + 1 })}
              aria-label="늘리기"
            >
              <Plus className="size-4" />
            </button>
          </span>
          <span>회마다 자동으로 수집해 승인함에 올려요</span>
        </div>
        {connected && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">
            <span>
              다음 수집까지 대화 <b>{st.bufferedTurns}</b>/{st.turnsPerBatch}회
            </span>
            <button
              className="ml-auto rounded-md border bg-background px-2.5 py-1 text-xs font-medium disabled:opacity-40"
              disabled={!st.bufferedTurns}
              onClick={ext.flush}
            >
              지금 수집하기
            </button>
          </div>
        )}
        <div>
          <p className="font-medium">이 팀 프로젝트와 관련된 대화만 수집</p>
          <p className="text-sm text-muted-foreground break-keep">
            수집한 발화를 AI로 분류하고 팀 관련 후보만 검토함에 보여줍니다. 팀 공유는 승인 후에만 진행됩니다.
          </p>
        </div>
        <ToggleRow
          title="수집 일시정지"
          desc="일시중지하면 새 수집과 AI 요청을 멈춥니다. 이미 승인한 카드의 전송은 계속됩니다."
          checked={connected ? !st.autoCollect : false}
          disabled={!connected}
          onChange={(paused) => ext.updateSettings({ autoCollect: !paused })}
        />
        {connected && st.endsAt && (
          <p className="text-sm text-muted-foreground">
            수집 종료 시각 {fmtMDHM(new Date(st.endsAt))} — 남은 대화는 보관하고 수집과 AI 요청을 멈춰요.
          </p>
        )}
      </section>

      {/* 최근 수집 */}
      <section className="rounded-xl border bg-card p-6">
        <h2 className="border-b pb-4 font-semibold">최근 수집</h2>
        {!connected || !st.recent.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {connected ? `ChatGPT에서 대화를 ${st.turnsPerBatch}회 나누면 여기에 쌓여요.` : "브라우저 확장을 연결하면 수집 기록이 보여요."}
          </p>
        ) : (
          <ul className="divide-y">
            {st.recent.slice(0, 6).map((b) => {
              const waiting = b.cardIds.filter((id) => pendingIds.has(id)).length;
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-3 py-4">
                  <div className="min-w-0">
                    <p className="font-medium">{b.site} 대화 수집</p>
                    <p className="text-sm text-muted-foreground">
                      대화 {b.turns}회 · {fmtMDHM(new Date(b.at))}
                      {b.trigger === "selection" && " · 선택한 내용"}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {waiting > 0 ? (
                      <>
                        <span className="rounded-full bg-tag-todo-soft px-3 py-1 text-sm font-semibold text-tag-todo">승인 대기 {waiting}건</span>
                        <Link href="/review" className={cn(buttonVariants(), "h-10 bg-brand px-4 hover:bg-brand-hover")}>
                          승인함 보기
                        </Link>
                      </>
                    ) : b.cardIds.length ? (
                      <span className="rounded-full bg-ok-soft px-3 py-1 text-sm font-semibold text-ok">검토 완료 {b.cardIds.length}건</span>
                    ) : (
                      <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">팀 관련 내용 없음</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
