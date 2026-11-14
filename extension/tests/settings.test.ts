import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ExtStatus } from '@shared/bridge';
import { fromLocalInput } from '@/entrypoints/popup/datetime-local';
import { saveSetup } from '@/entrypoints/popup/save-setup';
import { clampTurns, sendBlockedReason, settingsFromStatus, settingsItem, type Settings } from '@/lib/settings';

const ENDED_AT = '2026-11-08T00:00:00+00:00';
const status: ExtStatus = {
  version: '1',
  configured: false,
  autoCollect: false,
  turnsPerBatch: 12,
  bufferedTurns: 3,
  endsAt: ENDED_AT,
  lastCollectedAt: null,
  lastClassifier: 'native',
  teamName: '접근 불가',
  userName: '나',
  projectTopic: '주제',
  recent: [],
  teams: [{ id: 't1', name: '팀' }],
  counts: { reviewPending: 1 },
};
const stored = (changes: Partial<Settings>): Settings => ({ ...(settingsItem.fallback as Settings), ...changes });
const collectorAnswers = (response: object) => vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(response as never);

beforeEach(() => fakeBrowser.reset());

describe('settingsFromStatus', () => {
  it('확장이 정한 주소·소주제는 두고, 확장이 읽지 않는 status 필드는 담지 않는다', () => {
    const next = settingsFromStatus(stored({ webUrl: 'http://localhost:3000', enabledSubtopics: ['역할·일정'] }), status);
    expect(next).toMatchObject({ webUrl: 'http://localhost:3000', enabledSubtopics: ['역할·일정'] });
    expect(next).toMatchObject({ configured: false, teamName: '접근 불가', turnsPerBatch: 12, endsAt: ENDED_AT });
    expect(next).not.toHaveProperty('teams');
    expect(next).not.toHaveProperty('counts');
  });

  it('설정 화면에서 적은 팀 목표·범위·규칙은 수집기 상태로 새로 고쳐도 남는다', () => {
    const teamCriteria = { teamGoal: 'MVP 제출', teamRules: ['승인 후 공유'] };
    expect(settingsFromStatus(stored({ teamCriteria }), status).teamCriteria).toEqual(teamCriteria);
  });
});

describe('saveSetup (팝업 설정 저장)', () => {
  it('화면에 있는 주제·소주제만 수집기에 보내고, 소주제와 주소는 확장에도 저장한다', async () => {
    const sendMessage = collectorAnswers({ ok: true });
    await settingsItem.setValue(stored({ endsAt: ENDED_AT, turnsPerBatch: 12 }));

    const result = await saveSetup({ projectTopic: '새 주제', enabledSubtopics: ['자료 조사'], webUrl: 'http://localhost:3000' });

    expect(result).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'updateSettings', patch: { projectTopic: '새 주제', enabledSubtopics: ['자료 조사'] } });
    expect(await settingsItem.getValue()).toMatchObject({ webUrl: 'http://localhost:3000', enabledSubtopics: ['자료 조사'] });
  });

  it('수집기가 거절하면 확장 설정을 바꾸지 않고 오류를 돌려준다', async () => {
    collectorAnswers({ ok: false, error: '프로젝트 주제 오류' });
    const result = await saveSetup({ projectTopic: '주제', enabledSubtopics: [], webUrl: 'http://localhost:3000' });
    expect(result).toEqual({ ok: false, error: '프로젝트 주제 오류' });
    expect((await settingsItem.getValue()).webUrl).toBeUndefined();
  });
});

describe('수동 보내기를 막는 이유 (수집기는 수집 중일 때만 받는다)', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const ready = stored({ teamName: '팀', projectTopic: '주제', userName: '나', autoCollect: true, endsAt: '2026-11-12T13:00:00Z' });

  it('설정이 끝났고 수집 중이면 보낼 수 있다', () => {
    expect(sendBlockedReason(ready, now)).toBeNull();
  });

  it('설정 전 · 종료 시각 지남 · 일시정지 순으로 이유를 알려 준다', () => {
    expect(sendBlockedReason({ ...ready, projectTopic: ' ' }, now)).toBe('확장 아이콘을 눌러 먼저 설정해 주세요');
    expect(sendBlockedReason({ ...ready, autoCollect: false, endsAt: '2026-11-12T11:00:00Z' }, now)).toMatch(/^수집 종료 시각이 지났어요/);
    expect(sendBlockedReason({ ...ready, autoCollect: false }, now)).toBe('수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요');
  });
});

describe('팝업 입력값', () => {
  it('종료 시각 입력을 비우면 보낼 값이 없다 (수집기는 종료 시각 지우기를 받지 않는다)', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-11-09T23:30')).toBe(new Date('2026-11-09T23:30').toISOString());
  });
});
