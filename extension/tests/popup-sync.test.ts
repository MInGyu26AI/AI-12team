// 팝업의 '프로젝트만 수집'·'싱크 맞추기' (갈래 4). 백그라운드는 가짜 sendMessage 로 바꾼다
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { SyncNowResult } from '@shared/bridge';
import { SYNC_DEFAULTS, type SyncState } from '@/lib/chatgpt-sync/state';
import { settingsItem, type Settings } from '@/lib/settings';
import { MainScreen } from '@/entrypoints/popup/MainScreen';
import { RepoStatus } from '@/entrypoints/popup/RepoStatus';
import { StructureWarning } from '@/entrypoints/popup/StructureWarning';
import { ConsentText, SyncSwitch } from '@/entrypoints/popup/SyncSwitch';
import { runSyncNow, setProjectSync } from '@/entrypoints/popup/sync-actions';
import { syncNowBlockedReason, syncNowNotice, syncStatusLine } from '@/entrypoints/popup/sync-status';
import { formatAgo, formatClock } from '@/entrypoints/popup/time-format';

const NOW = new Date(2026, 10, 13, 14, 0).getTime(); // 지역 시간 11/13 14:00
const at = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();
const PROJECT = { gizmoId: 'g-p-1', name: '해커톤' };
const synced = (changes: Partial<SyncState>): SyncState => ({ ...SYNC_DEFAULTS, enabled: true, project: PROJECT, mode: 'idle', ...changes });
const settings = (changes: Partial<Settings> = {}): Settings => ({
  ...(settingsItem.fallback as Settings),
  teamName: '팀',
  projectTopic: '주제',
  userName: '나',
  autoCollect: true,
  endsAt: at(60),
  ...changes,
});
const backendAnswers = (response: object) => vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(response as never);

beforeEach(() => {
  vi.restoreAllMocks(); // 앞 시험의 가짜 sendMessage 호출 기록을 지운다
  fakeBrowser.reset();
});

describe('시각 표시', () => {
  it('얼마 전인지 쉽게 말한다', () => {
    expect([0, 59, 60, 59 * 60, 60 * 60, 25 * 3600].map((s) => formatAgo(new Date(NOW - s * 1000).toISOString(), NOW))).toEqual([
      '방금 전',
      '방금 전',
      '1분 전',
      '59분 전',
      '1시간 전',
      '1일 전',
    ]);
    expect(formatAgo('읽을 수 없음', NOW)).toBe('방금 전');
  });

  it('오늘 시각은 시:분, 다른 날은 날짜를 붙인다', () => {
    expect(formatClock(at(30), NOW)).toBe('14:30');
    expect(formatClock(at(12 * 60), NOW)).toBe('11/14 02:00');
    expect(formatClock('읽을 수 없음', NOW)).toBe('');
  });
});

describe('상태 한 줄 (syncStatusLine)', () => {
  it('꺼져 있으면 그리지 않는다', () => {
    expect(syncStatusLine(SYNC_DEFAULTS, NOW)).toBeNull();
  });

  it('켜져 있으면 마지막 확인과 프로젝트를 보여 준다', () => {
    expect(syncStatusLine(synced({ lastPassFinishedAt: at(-3) }), NOW)).toEqual({ tone: 'info', text: '동기화: 3분 전 · 해커톤 프로젝트' });
    expect(syncStatusLine(synced({}), NOW)?.text).toBe('동기화: 곧 첫 확인 · 해커톤 프로젝트');
    expect(syncStatusLine(synced({ mode: 'running' }), NOW)?.text).toBe('동기화: 확인 중 · 해커톤 프로젝트');
  });

  it('쉬는 중이면 이유와 다시 보는 시각을 보여 준다', () => {
    const rest = synced({ mode: 'rest', restReason: 'rate_limited', restUntil: at(30) });
    expect(syncStatusLine(rest, NOW)).toEqual({ tone: 'info', text: '쉼: 요청 제한 · 14:30에 다시' });
    expect(syncStatusLine({ ...rest, restReason: 'forbidden', restUntil: null }, NOW)?.text).toBe('쉼: 접속 제한');
  });

  it('멈췄으면 사용자가 할 일을 말한다', () => {
    const stopped = (stopReason: SyncState['stopReason']) => syncStatusLine(synced({ mode: 'stopped', stopReason }), NOW);
    expect(stopped('no_tab')).toEqual({ tone: 'error', text: 'chatgpt.com 탭을 열어 두세요' });
    expect(stopped('logged_out')?.text).toBe('ChatGPT에 로그인하세요');
    expect(stopped('account_mismatch')?.text).toMatch(/다른 ChatGPT 계정/);
    expect(stopped('shape_changed')?.text).toMatch(/화면이 바뀌어/);
    expect(stopped('collection_paused')?.text).toMatch(/자동 수집을 다시 켜/);
    expect(stopped(null)?.tone).toBe('error');
  });
});

describe('싱크 맞추기 안내 (syncNowNotice)', () => {
  const result = (changes: Partial<SyncNowResult>): SyncNowResult => ({ sync: 'ran', newTurns: 0, flushed: true, ...changes });

  it('가져온 턴 수와 분류 여부를 함께 말한다', () => {
    expect(syncNowNotice(result({ newTurns: 3 }))).toEqual({ tone: 'ok', text: '새 대화 3회를 가져왔어요. 쌓인 대화는 분류에 보냈어요' });
    expect(syncNowNotice(result({ flushed: false }))).toEqual({ tone: 'ok', text: '새로 가져올 대화는 없어요' });
  });

  it('동기화가 꺼져 있어도 flush 결과를 알린다', () => {
    expect(syncNowNotice(result({ sync: 'off' }))).toEqual({ tone: 'ok', text: '쌓인 대화는 분류에 보냈어요' });
    const blocked = result({ sync: 'off', flushed: false, blockedReason: '수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요' });
    expect(syncNowNotice(blocked)).toEqual({ tone: 'info', text: '수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요' });
  });

  it('쉼 · 이미 도는 중 · 탭 없음 · 실패를 구분한다', () => {
    expect(syncNowNotice(result({ sync: 'resting', flushed: false }))).toEqual({ tone: 'info', text: '동기화는 쉬는 중이에요' });
    expect(syncNowNotice(result({ sync: 'busy', flushed: false })).text).toBe('동기화가 이미 돌고 있어요');
    expect(syncNowNotice(result({ sync: 'no-tab', flushed: false }))).toEqual({ tone: 'error', text: 'chatgpt.com 탭을 열어 두세요' });
    expect(syncNowNotice(result({ sync: 'failed', flushed: false })).tone).toBe('error');
  });
});

describe('싱크 맞추기 버튼을 막는 이유', () => {
  it('수동 보내기와 같은 차단 판정을 그대로 쓴다', () => {
    expect(syncNowBlockedReason(settings({ autoCollect: false }), true, NOW)).toBe('수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요');
    expect(syncNowBlockedReason(settings({ projectTopic: '' }), true, NOW)).toBe('확장 아이콘을 눌러 먼저 설정해 주세요');
    expect(syncNowBlockedReason(settings({ endsAt: at(-1) }), true, NOW)).toMatch(/^수집 종료 시각이 지났어요/);
  });

  it('동기화가 꺼져 있으면 쌓인 대화가 있을 때만 누를 수 있다', () => {
    expect(syncNowBlockedReason(settings({ bufferedTurns: 0 }), false, NOW)).toMatch(/^쌓인 대화가 없어요/);
    expect(syncNowBlockedReason(settings({ bufferedTurns: 2 }), false, NOW)).toBeNull();
  });

  it('동기화가 켜져 있으면 쌓인 대화가 없어도 새 대화를 가져오러 누를 수 있다', () => {
    expect(syncNowBlockedReason(settings({ bufferedTurns: 0 }), true, NOW)).toBeNull();
  });
});

describe('백그라운드에 보내는 요청', () => {
  it('켤 때는 고른 프로젝트와 함께 syncSet 을 보낸다', async () => {
    const state = synced({ lastPassFinishedAt: at(0) });
    const sendMessage = backendAnswers({ ok: true, result: state });
    expect(await setProjectSync(true, PROJECT)).toEqual({ ok: true, state });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'syncSet', enabled: true, project: PROJECT });
  });

  it('끌 때는 프로젝트 없이 syncSet 을 보낸다', async () => {
    const sendMessage = backendAnswers({ ok: true, result: SYNC_DEFAULTS });
    await setProjectSync(false);
    expect(sendMessage.mock.calls[0]?.[0]).toStrictEqual({ type: 'syncSet', enabled: false });
  });

  it('켜기가 실패하면 받은 문구를 그대로 돌려준다', async () => {
    backendAnswers({ ok: false, error: 'chatgpt.com 탭을 하나 열어 두세요' });
    expect(await setProjectSync(true, PROJECT)).toEqual({ ok: false, error: 'chatgpt.com 탭을 하나 열어 두세요' });
  });

  it('백그라운드가 답하지 않으면 안내 문구를 만든다', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Receiving end does not exist'));
    expect(await setProjectSync(true, PROJECT)).toEqual({ ok: false, error: '동기화 설정을 바꾸지 못했어요' });
    expect(await runSyncNow()).toEqual({ tone: 'error', text: '싱크 맞추기 요청이 실패했어요' });
  });

  it('싱크 맞추기는 button 이유로 syncNow 를 보내고 결과를 안내한다', async () => {
    const sendMessage = backendAnswers({ ok: true, result: { sync: 'ran', newTurns: 2, flushed: true } satisfies SyncNowResult });
    expect(await runSyncNow()).toEqual({ tone: 'ok', text: '새 대화 2회를 가져왔어요. 쌓인 대화는 분류에 보냈어요' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'syncNow', params: { reason: 'button' } });
  });

  it('싱크 맞추기 요청이 거절되면 받은 문구를 보여 준다', async () => {
    backendAnswers({ ok: false, error: '수집기에 연결하지 못했어요' });
    expect(await runSyncNow()).toEqual({ tone: 'error', text: '수집기에 연결하지 못했어요' });
  });
});

describe('팝업 화면 그리기', () => {
  it('프로젝트만 수집은 기본이 꺼짐이고, 켜기 전에는 동의 문구를 그리지 않는다', () => {
    const html = renderToStaticMarkup(createElement(SyncSwitch, { sync: SYNC_DEFAULTS }));
    expect(html).toContain('프로젝트만 수집');
    expect(html).not.toContain('checked=""'); // 클래스 이름 peer-checked 와 헷갈리지 않게 속성 모양으로 본다
    expect(html).not.toContain('동의하고 켜기');
  });

  it('켜져 있으면 스위치가 켜지고 상태 한 줄이 보인다', () => {
    const html = renderToStaticMarkup(createElement(SyncSwitch, { sync: synced({ mode: 'stopped', stopReason: 'no_tab' }) }));
    expect(html).toContain('checked=""');
    expect(html).toContain('chatgpt.com 탭을 열어 두세요');
  });

  it('동의 문구는 고른 프로젝트 대화만 가져오고 승인한 것만 공유한다는 말이 중심이다', () => {
    const html = renderToStaticMarkup(createElement(ConsentText));
    expect(html).toContain('고른 프로젝트 대화만 가져오고, 승인한 것만 공유해요');
    expect(html).toContain('임시 채팅은 빠져요');
    expect(html).toContain('외부 AI');
  });

  it('구조 경고와 레포 상태는 값이 없으면 아무것도 그리지 않는다', () => {
    expect(renderToStaticMarkup(createElement(StructureWarning, { warning: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(StructureWarning, { warning: undefined }))).toBe('');
    expect(renderToStaticMarkup(createElement(RepoStatus, { repo: null }))).toBe('');
  });

  it('값이 있으면 구조 경고는 안내와 진단 복사 버튼을, 레포 상태는 이름과 저장 시각을 그린다', () => {
    const warning = renderToStaticMarkup(createElement(StructureWarning, { warning: { message: '대화를 못 읽고 있어요', diagnostics: 'a=0' } }));
    expect(warning).toContain('대화를 못 읽고 있어요');
    expect(warning).toContain('진단 복사');
    expect(renderToStaticMarkup(createElement(StructureWarning, { warning: { message: '대화를 못 읽고 있어요' } }))).not.toContain('진단 복사');
    const repo = renderToStaticMarkup(createElement(RepoStatus, { repo: { name: 'AI-12team', lastSavedAt: new Date(Date.now() - 5 * 60_000).toISOString() } }));
    expect(repo).toContain('AI-12team');
    expect(repo).toContain('5분 전');
  });

  it('메인 화면에는 싱크 맞추기가 있고 지금 분류하기와 N회마다 조절은 없다', () => {
    const html = renderToStaticMarkup(
      createElement(MainScreen, { settings: settings(), syncState: SYNC_DEFAULTS, lastError: null, pendingCount: 0, onEdit: () => {} }),
    );
    expect(html).toContain('싱크 맞추기');
    expect(html).toContain('프로젝트만 수집');
    expect(html).not.toContain('지금 분류하기');
    expect(html).not.toContain('회마다');
    expect(html).not.toContain('늘리기');
    expect(html).toContain('수집 종료 시각');
  });
});
