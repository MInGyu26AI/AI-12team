import { useState } from 'react';
import { isConfigured, type Settings } from '@/lib/settings';
import { normalizeWebUrl, webUrlOf } from '@/lib/web-url';
import { Notice } from './Notice';
import { saveSetup } from './save-setup';
import { SubtopicPicker } from './SubtopicPicker';
import { TextField } from './TextField';
import { WebUrlField } from './WebUrlField';

interface SetupFormProps {
  initial: Settings;
  firstTime: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}

// 처음 설정 · 설정 수정. 팀과 사용자는 로컬 수집기 연결에서 오므로 여기서는 보여 주기만 한다
export function SetupForm({ initial, firstTime, onSaved, onCancel }: SetupFormProps) {
  const [{ teamName, userName }] = useState(initial);
  const [projectTopic, setProjectTopic] = useState(initial.projectTopic);
  const [subtopics, setSubtopics] = useState(initial.enabledSubtopics);
  const [webUrlInput, setWebUrlInput] = useState(webUrlOf(initial));
  const webUrl = normalizeWebUrl(webUrlInput);
  const canSave = isConfigured({ ...initial, teamName, userName, projectTopic }) && !!webUrl;

  const submit = async () => {
    if (!canSave) return;
    const result = await saveSetup({ projectTopic: projectTopic.trim(), enabledSubtopics: subtopics, webUrl });
    if (result.ok) onSaved();
    else alert(result.error);
  };

  return (
    <form
      className="w-[340px] space-y-3 p-4 font-sans text-sm text-gray-900"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="text-base font-bold">{firstTime ? '싱크업 처음 설정' : '설정 수정'}</h1>
      {firstTime && <Notice tone="error">설정 안 됨: 아래 정보를 입력해야 수집을 시작할 수 있어요.</Notice>}

      <TextField label="등록된 팀 이름" value={teamName} placeholder="로컬 수집기 연결 필요" />
      <TextField label="프로젝트 주제" value={projectTopic} onChange={setProjectTopic} placeholder="예: 팀 AI 메모리 서비스" />
      <TextField label="연결된 사용자" value={userName} placeholder="로컬 수집기 연결 필요" />

      <SubtopicPicker value={subtopics} onChange={setSubtopics} />
      <WebUrlField value={webUrlInput} normalized={webUrl} onChange={setWebUrlInput} />

      {/* 최초 설정에서 자동 수집 범위와 외부 AI 전송을 알려야 한다 (CLAUDE.md 9장 개인정보·보안 원칙) */}
      <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
        <p className="font-medium text-gray-800">수집 범위 안내</p>
        <p>· 자동 수집을 켜면 chatgpt.com 에서 새로 끝난 대화(내 말·AI 답변)를 읽어요.</p>
        <p>· 선택한 발화는 로컬에 저장하고, 민감정보를 가린 뒤 외부 AI로 보내 분류합니다.</p>
        <p>· 팀 관련 후보만 검토함에 표시하고, 승인한 카드만 팀에 공유합니다.</p>
      </div>

      <div className="flex gap-2">
        {onCancel && (
          <button type="button" className="flex-1 rounded-lg border px-3 py-2" onClick={onCancel}>
            취소
          </button>
        )}
        <button
          type="submit"
          disabled={!canSave}
          className="flex-1 rounded-lg bg-gray-900 px-3 py-2 font-medium text-white disabled:opacity-40"
        >
          저장
        </button>
      </div>
    </form>
  );
}
