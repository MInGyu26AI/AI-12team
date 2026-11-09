"use client";

import type { ExtSettingsPatch, ExtStatus } from "@shared/bridge";
import { fmtHM, ymd } from "@shared/format";

// <input type="datetime-local"> 값 (로컬 시각)
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${ymd(d)}T${fmtHM(d)}`;
};

// 승인 대상 팀 · 프로젝트 주제 · 수집 종료 시각. 글자 칸은 값이 바뀌었을 때만 collection.configure 로 보낸다
export function CollectionSettings({ status, onChange }: { status: ExtStatus; onChange: (patch: ExtSettingsPatch) => void }) {
  const topic = status.projectTopic ?? "";
  const endsAt = toLocalInput(status.endsAt);
  return (
    <section className="space-y-3 rounded-xl border bg-card p-6">
      <label className="block">
        승인 대상 팀
        <select
          aria-label="승인 대상 팀"
          value={status.teamId ?? ""}
          onChange={(e) => onChange({ teamId: e.target.value })}
          className="ml-3 rounded border p-2"
        >
          {status.teams?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        프로젝트 주제
        <input
          aria-label="프로젝트 주제"
          key={topic}
          defaultValue={topic}
          onBlur={(e) => e.target.value !== topic && onChange({ projectTopic: e.target.value })}
          className="ml-3 rounded border p-2"
        />
      </label>
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
