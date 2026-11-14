import { useState } from 'react';
import { startsEditable, TOPIC_EDIT_CONFIRM, TOPIC_SHARED_NOTE } from '@shared/team-topic';

interface TopicFieldProps {
  value: string;
  saved: string; // 저장돼 있던 주제(수집기 상태). 비어 있으면 처음 설정이라 확인 없이 바로 쓴다
  onChange: (value: string) => void;
}

// 프로젝트 주제(팀 공유). 주제가 있으면 읽기 전용으로 보이고, 끝의 '수정'을 눌러 확인(예/아니오)한 뒤에만 고친다
export function TopicField({ value, saved, onChange }: TopicFieldProps) {
  const [editing, setEditing] = useState(startsEditable(saved));
  const [asking, setAsking] = useState(false);
  return (
    <div className="space-y-1">
      <label htmlFor="project-topic" className="font-medium">
        프로젝트 주제 <span className="text-xs font-normal text-gray-500">팀 공유</span>
      </label>
      <div className="flex gap-1.5">
        <input
          id="project-topic"
          readOnly={!editing}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="예: 팀 AI 메모리 서비스"
          className="min-w-0 flex-1 rounded-md border px-2.5 py-1.5 outline-none read-only:bg-gray-50 focus:border-tag-decision"
        />
        {!editing && (
          <button type="button" className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs" onClick={() => setAsking(true)}>
            수정
          </button>
        )}
      </div>
      {asking && (
        <div role="alertdialog" aria-label="프로젝트 주제 수정 확인" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs">
          <p>{TOPIC_EDIT_CONFIRM}</p>
          <div className="flex justify-end gap-1.5">
            <button type="button" className="rounded border bg-white px-2.5 py-1" onClick={() => setAsking(false)}>
              아니오
            </button>
            <button
              type="button"
              autoFocus
              className="rounded bg-gray-900 px-2.5 py-1 text-white"
              onClick={() => {
                setAsking(false);
                setEditing(true);
              }}
            >
              예
            </button>
          </div>
        </div>
      )}
      <p className="text-xs text-gray-500">{TOPIC_SHARED_NOTE}</p>
    </div>
  );
}
