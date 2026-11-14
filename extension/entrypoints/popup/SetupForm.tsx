import { useState } from 'react';
import { cleanCriteria, rulesFromText } from '@shared/criteria';
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
  const [goal, setGoal] = useState(initial.teamCriteria?.teamGoal ?? '');
  const [scope, setScope] = useState(initial.teamCriteria?.teamScope ?? '');
  const [rules, setRules] = useState((initial.teamCriteria?.teamRules ?? []).join('\n'));
  const webUrl = normalizeWebUrl(webUrlInput);
  const canSave = isConfigured({ ...initial, teamName, userName, projectTopic }) && !!webUrl;

  const submit = async () => {
    if (!canSave) return;
    const teamCriteria = cleanCriteria({ teamGoal: goal, teamScope: scope, teamRules: rulesFromText(rules) });
    const result = await saveSetup({ projectTopic: projectTopic.trim(), enabledSubtopics: subtopics, webUrl, teamCriteria });
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

      {/* 프로젝트 방향성 기준 (선택). AI 가 프로젝트 대화를 고르는 기준 (shared/criteria.ts) */}
      <fieldset className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 font-medium">팀 목표·범위·규칙 (선택)</legend>
        <TextField label="팀 목표" value={goal} onChange={setGoal} placeholder="예: 11/16까지 시연 가능한 MVP 제출" />
        <TextField label="범위" value={scope} onChange={setScope} placeholder="예: ChatGPT 웹 + 팀 보드까지, 결제는 제외" />
        <label className="block space-y-1">
          <span className="font-medium">규칙 (한 줄에 하나)</span>
          <textarea
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            rows={2}
            placeholder={'예: 결정은 팀장 승인 후 확정\n개인 일정은 올리지 않기'}
            className="w-full resize-none rounded-md border px-2.5 py-1.5 outline-none focus:border-tag-decision"
          />
        </label>
        <p className="text-xs text-gray-500">AI가 프로젝트 대화를 고르는 기준이 돼요. 지금은 이 확장에 저장돼요.</p>
      </fieldset>

      <WebUrlField value={webUrlInput} normalized={webUrl} onChange={setWebUrlInput} />

      {/* 최초 설정에서 자동 수집 범위와 외부 AI 전송을 알려야 한다 (CLAUDE.md 9장 개인정보·보안 원칙) */}
      <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
        <p className="font-medium text-gray-800">프로젝트 대화만 가져오고, 내가 승인한 것만 팀에 공유합니다</p>
        <p>· 자동 수집을 켠 동안 chatgpt.com 에서 새로 끝난 대화(내 말·AI 답변)를 읽어요. 프로젝트 대화를 할 때만 켜 주세요.</p>
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
          className="flex-1 rounded-lg bg-gray-900 px-3 py-2 font-medium text-white disabled:opacity-40"
        >
          저장
        </button>
      </div>
    </form>
  );
}
