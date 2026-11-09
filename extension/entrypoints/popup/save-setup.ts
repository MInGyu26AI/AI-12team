import type { Subtopic } from '@shared/types';
import { sendToBackground } from '@/lib/messages';
import { settingsItem } from '@/lib/settings';

export interface SetupValues {
  projectTopic: string;
  enabledSubtopics: Subtopic[];
  webUrl: string;
}

/**
 * 설정 화면 저장: 프로젝트 주제와 소주제는 로컬 수집기에, 개인 검토함 주소와 소주제는 확장에 저장한다.
 * 종료 시각 · 묶음 크기 · 자동 수집은 이 화면에 없으므로 보내지 않는다 (지난 종료 시각을 다시 보내면 수집기가 저장을 거절한다).
 */
export async function saveSetup({ projectTopic, enabledSubtopics, webUrl }: SetupValues) {
  const result = await sendToBackground({ type: 'updateSettings', patch: { projectTopic, enabledSubtopics } });
  if (!result?.ok) return { ok: false as const, error: result?.error ?? '로컬 수집기 연결 실패' };
  // 수집기 status 에는 소주제가 없어서, 다시 열었을 때 고른 소주제가 보이도록 확장에도 둔다
  await settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl, enabledSubtopics });
  return { ok: true as const };
}
