"use client";

import { useState } from "react";
import { startsEditable, TOPIC_EDIT_CONFIRM, TOPIC_SHARED_NOTE } from "@shared/team-topic";
import { buttonOutline, buttonPrimary, input } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 프로젝트 주제(팀 공유). 주제가 있으면 읽기 전용으로 보이고, 끝의 '수정'을 눌러 확인(예/아니오)한 뒤에만 고친다.
// 부모가 key={topic} 으로 다시 그리므로 다른 팀원이 주제를 바꾸면 새 값으로 돌아간다
export function TopicField({ topic, onSave }: { topic: string; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(startsEditable(topic));
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState(topic);
  const save = () => {
    const value = draft.trim();
    if (value !== topic) onSave(value);
    if (value) setEditing(false);
  };
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium">
          프로젝트 주제 <span className="font-normal text-text-tertiary">팀 공유</span>
        </span>
        <span className="flex gap-2">
          <input
            aria-label="프로젝트 주제"
            readOnly={!editing}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && editing && save()}
            className={input}
          />
          {editing ? (
            <button type="button" onClick={save} className={cn(buttonPrimary, "h-10 py-0")}>
              저장
            </button>
          ) : (
            <button type="button" onClick={() => setAsking(true)} className={cn(buttonOutline, "h-10 py-0")}>
              수정
            </button>
          )}
        </span>
      </label>
      {asking && (
        <div role="alertdialog" aria-label="프로젝트 주제 수정 확인" className="space-y-2 rounded-md bg-surface-soft p-3 text-sm">
          <p className="break-keep">{TOPIC_EDIT_CONFIRM}</p>
          <div className="flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setAsking(false);
                setEditing(true);
              }}
              className={cn(buttonPrimary, "px-3 py-1.5")}
            >
              예
            </button>
            <button type="button" onClick={() => setAsking(false)} className={cn(buttonOutline, "px-3 py-1.5")}>
              아니오
            </button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground break-keep">{TOPIC_SHARED_NOTE}</p>
    </div>
  );
}
