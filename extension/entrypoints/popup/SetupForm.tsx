import { useState } from 'react';
import { isConfigured, settingsItem, type Settings } from '@/lib/settings';
import { normalizeWebUrl, webUrlOf } from '@/lib/web-url';
import { Notice } from './Notice';
import { saveSetup } from './save-setup';
import { SubtopicPicker } from './SubtopicPicker';
import { TextField } from './TextField';
import { TopicField } from './TopicField';
import { WebUrlField } from './WebUrlField';

interface SetupFormProps {
  initial: Settings;
  firstTime: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}

// 처음 설정 · 설정 수정. 팀과 사용자는 로컬 수집기 연결에서 오므로 여기서는 보여 주기만 한다
export function SetupForm({ initial, firstTime, onSaved, onCancel }: SetupFormProps) {
  // 팀·사용자는 수집기 상태에서 늦게 올 수 있어 상태로 얼리지 않고 매번 props 에서 읽는다 (팝업을 연 뒤 도착해도 보이고 저장 가능)
  const { teamName, userName } = initial;
  const [projectTopic, setProjectTopic] = useState(initial.projectTopic);
  const [subtopics, setSubtopics] = useState(initial.enabledSubtopics);
  const [webUrlInput, setWebUrlInput] = useState(webUrlOf(initial));
  const [addressStatus, setAddressStatus] = useState('');
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
      className="w-[340px] space-y-3 p-4 font-sans text-sm text-foreground"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="text-base font-bold">{firstTime ? '싱크업 처음 설정' : '설정 수정'}</h1>
      {firstTime && <Notice tone="error">설정 안 됨: 아래 정보를 입력해야 수집을 시작할 수 있어요.</Notice>}

      <TextField label="등록된 팀 이름" value={teamName} placeholder="로컬 수집기 연결 필요" />
      <TopicField value={projectTopic} saved={initial.projectTopic} onChange={setProjectTopic} />
      <TextField label="연결된 사용자" value={userName} placeholder="로컬 수집기 연결 필요" />

      <SubtopicPicker value={subtopics} onChange={setSubtopics} />

      <WebUrlField value={webUrlInput} normalized={webUrl} onChange={setWebUrlInput} />
      <button type="button" disabled={!webUrl} className="w-full rounded-lg border px-3 py-2 disabled:opacity-40"
        onClick={async () => {
          if (!webUrl) return;
          try {
            await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl });
            setAddressStatus('주소를 저장했어요. 웹의 PC 연결 페이지를 새로고침해 주세요.');
          } catch {
            setAddressStatus('주소를 저장하지 못했어요. 다시 시도해 주세요.');
          }
        }}>연결 주소만 저장</button>
      {addressStatus && <p role="status" className="text-xs text-gray-600">{addressStatus}</p>}

      {/* 최초 설정에서 자동 수집 범위와 외부 AI 전송을 알려야 한다 (CLAUDE.md 9장 개인정보·보안 원칙) */}
      <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
        <p className="font-medium text-gray-800">프로젝트 대화만 가져오고, 내가 승인한 것만 팀에 공유합니다</p>
        <p>· 자동 수집을 켠 동안 chatgpt.com 에서 새로 끝난 대화(내 말·AI 답변)를 읽어요.</p>
        <p>· 프로젝트 주제와 관련된 내용만 후보로 골라 내 검토함에 보여 줘요. 고르기 위해 민감정보를 가린 발췌를 외부 AI로 보냅니다.</p>
        <p>· 팀에는 내가 승인한 카드만 공유하고, 원본 대화 전체는 보내지 않아요.</p>
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
          className="flex-1 rounded-lg bg-brand px-3 py-2 font-medium text-white disabled:opacity-40"
        >
          저장
        </button>
      </div>
    </form>
  );
}
