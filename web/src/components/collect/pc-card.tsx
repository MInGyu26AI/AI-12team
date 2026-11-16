"use client";

import Link from "next/link";
import type { ExtStatus } from "@shared/bridge";
import { fmtMDHM } from "@shared/format";
import type { CollectorLink } from "@/lib/local-collector";
import { cn } from "@/lib/utils";
import { btnOutline, panel, panelTitle, rowLine } from "./collect-ui";

// 연결 상태 탭의 "이 PC" 카드: 이 PC의 로컬 수집기가 알려 주는 연결 정보 4줄(높이 44, 머리카락 선)과 다시 확인·계정 바꾸기.
// status = 수집기에 닿았을 때만 있다. mock = 예시 모드(수집기에 요청하지 않음)
export function PcCard({ link, status, mock, rechecking, onRecheck }: {
  link: CollectorLink;
  status: ExtStatus | null;
  mock: boolean;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const on = !mock && link === "connected";
  const rows: { label: string; value: string }[] = [
    { label: "연결된 사용자", value: status?.userName || "—" },
    { label: "승인 대상 팀", value: status ? status.teamName || "고르지 않음" : "—" },
    { label: "수집기", value: collectorText(link, mock) },
    { label: "마지막 수집", value: status ? (status.lastCollectedAt ? fmtMDHM(new Date(status.lastCollectedAt)) : "아직 없음") : "—" },
  ];
  return (
    <section className={panel} aria-labelledby="pc-card-title">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <h2 id="pc-card-title" className={panelTitle}>
          이 PC
        </h2>
        <span className={cn("flex items-center gap-2 text-[13px]", on ? "text-ok" : "text-ink-2")}>
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", on ? "bg-ok" : "border border-card-border-personal")} />
          {mock ? "예시 모드" : on ? "연결됨" : link === "checking" ? "확인 중" : "연결 안 됨"}
        </span>
      </div>
      <dl>
        {rows.map((row) => (
          <div key={row.label} className={cn(rowLine, "flex h-11 items-center justify-between gap-4 px-5 text-sm")}>
            <dt className="shrink-0 text-ink-2">{row.label}</dt>
            <dd className="min-w-0 truncate text-right text-ink" title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className={cn(rowLine, "flex flex-wrap gap-2 px-5 py-4")}>
        <button type="button" className={btnOutline} disabled={rechecking} onClick={onRecheck}>
          {rechecking ? "확인 중…" : "다시 확인"}
        </button>
        <Link href="/connect" className={btnOutline}>
          연결 계정 바꾸기
        </Link>
      </div>
    </section>
  );
}

function collectorText(link: CollectorLink, mock: boolean) {
  if (mock) return "예시 모드";
  switch (link) {
    case "connected":
      return "실행 중";
    case "collector-off":
      return "꺼짐";
    case "extension-missing":
      return "브라우저 확장 응답 없음";
    default:
      return "확인 중";
  }
}
