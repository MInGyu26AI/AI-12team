"use client";

import type { ExtSettingsPatch, ExtStatus } from "@shared/bridge";
import { fmtHM, ymd } from "@shared/format";
import { TopicField } from "./topic-field";

// <input type="datetime-local"> 값 (로컬 시각)
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${ymd(d)}T${fmtHM(d)}`;
};

// 승인 대상 팀 · 프로젝트 주제 · 수집 종료 시각. 글자 칸은 값이 바뀌었을 때만 collection.configure 로 보낸다
export function CollectionSettings({ status, onChange }: { status: ExtStatus; onChange: (patch: ExtSettingsPatch) => void }) {
  const topic = status.projectTopic ?? "";
  const endsAt = toLocalInput(status.endsAt);
  // 팀이 아직 없거나, 묶인 팀이 소속 팀 목록에 없으면(권한 회수 등) 빈 칸을 보인다.
  // 빈 칸이 없으면 브라우저가 첫 팀을 고른 것처럼 보여 주고, 그 팀을 골라도 바뀐 것이 없어 저장되지 않는다
  const known = !!status.teamId && !!status.teams?.some((t) => t.id === status.teamId);
  return (
    <section className="space-y-3 rounded-xl border bg-card p-6">
      <label className="block">
        승인 대상 팀
        <select
          aria-label="승인 대상 팀"
          value={known ? status.teamId! : ""}
          onChange={(e) => onChange({ teamId: e.target.value })}
          className="ml-3 rounded border p-2"
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
        <p className="text-sm text-destructive">
          {status.teamId
            ? "지금 묶인 팀에 더 이상 접근할 수 없습니다. 승인 대상 팀을 다시 고르세요."
            : "승인 대상 팀을 먼저 고르세요. 팀을 고르기 전에는 수집한 대화를 받지 않습니다."}
        </p>
      )}
      <TopicField key={topic} topic={topic} onSave={(projectTopic) => onChange({ projectTopic })} />
      {/* 확장의 자동 수집은 팀·주제·이름이 모두 있어야 켜진다 (extension/lib/settings.ts isConfigured) */}
      {!topic.trim() && (
        <p className="text-sm text-destructive">프로젝트 주제를 입력하세요. 주제가 비어 있으면 브라우저 확장이 대화를 자동으로 수집하지 않습니다.</p>
      )}
      <label className="block">
        수집 종료 시각
        <input
          aria-label="수집 종료 시각"
          type="datetime-local"
          key={endsAt}
          defaultValue={endsAt}
          onBlur={(e) => e.target.value && e.target.value !== endsAt && onChange({ endsAt: new Date(e.target.value).toISOString() })}
          className="ml-3 rounded border p-2"
        />
      </label>
      <p className="text-sm text-muted-foreground">이미 승인한 카드의 대상 팀은 변경되지 않습니다.</p>
    </section>
  );
}
