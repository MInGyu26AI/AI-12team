"use client";

import type { ExtSettingsPatch, ExtStatus } from "@shared/bridge";
import { fmtHM, ymd } from "@shared/format";
import { card, input } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { TopicField } from "./topic-field";

// <input type="datetime-local"> 값 (로컬 시각)
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${ymd(d)}T${fmtHM(d)}`;
};

// 승인 대상 팀 · 프로젝트 주제 · 수집 종료 시각. 글자 칸은 값이 바뀌었을 때만 collection.configure 로 보낸다.
// 피그마 3번에 없는 기존 설정이라 같은 흰 카드(테두리 #e2d6c3 · 모서리 12)로 둔다. children = 카드 맨 아래 줄 (레포 연결 상태)
export function CollectionSettings({ status, onChange, children }: {
  status: ExtStatus;
  onChange: (patch: ExtSettingsPatch) => void;
  children?: React.ReactNode;
}) {
  const topic = status.projectTopic ?? "";
  const endsAt = toLocalInput(status.endsAt);
  // 팀이 아직 없거나, 묶인 팀이 소속 팀 목록에 없으면(권한 회수 등) 빈 칸을 보인다.
  // 빈 칸이 없으면 브라우저가 첫 팀을 고른 것처럼 보여 주고, 그 팀을 골라도 바뀐 것이 없어 저장되지 않는다
  const known = !!status.teamId && !!status.teams?.some((t) => t.id === status.teamId);
  return (
    <section className={cn(card, "space-y-4 p-5")} aria-label="수집 설정">
      <h2 className="text-base leading-[1.5] font-bold">수집 설정</h2>
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium">승인 대상 팀</span>
        <select
          aria-label="승인 대상 팀"
          value={known ? status.teamId! : ""}
          onChange={(e) => onChange({ teamId: e.target.value })}
          className={cn(input, "block sm:w-80")}
        >
          {!known && (
            <option value="" disabled>
              팀을 선택하세요
            </option>
          )}
          {status.teams?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {!known && (
        <p className="text-sm text-destructive break-keep">
          {status.teamId
            ? "지금 묶인 팀에 더 이상 접근할 수 없습니다. 승인 대상 팀을 다시 고르세요."
            : "승인 대상 팀을 먼저 고르세요. 팀을 고르기 전에는 수집한 대화를 받지 않습니다."}
        </p>
      )}
      <TopicField key={topic} topic={topic} onSave={(projectTopic) => onChange({ projectTopic })} />
      {/* 확장의 자동 수집은 팀·주제·이름이 모두 있어야 켜진다 (extension/lib/settings.ts isConfigured) */}
      {!topic.trim() && (
        <p className="text-sm text-destructive break-keep">프로젝트 주제를 입력하세요. 주제가 비어 있으면 브라우저 확장이 대화를 자동으로 수집하지 않습니다.</p>
      )}
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium">수집 종료 시각</span>
        <input
          aria-label="수집 종료 시각"
          type="datetime-local"
          key={endsAt}
          defaultValue={endsAt}
          onBlur={(e) => e.target.value && e.target.value !== endsAt && onChange({ endsAt: new Date(e.target.value).toISOString() })}
          className={cn(input, "block sm:w-80")}
        />
      </label>
      <p className="text-xs text-muted-foreground">이미 승인한 카드의 대상 팀은 변경되지 않습니다.</p>
      {children && <div className="border-t border-card-border pt-3">{children}</div>}
    </section>
  );
}
