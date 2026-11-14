// @vitest-environment happy-dom
// 승인 전 미리 알림: 문구(shared/pre-alert.ts) · 같은 key 는 한 번만 알림(lib/pre-alert-notice.ts) · 팝업 목록(PreAlertList)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { gwaWa, preAlertText, type PreAlertSummary } from '@shared/pre-alert';
import { PreAlertList } from '@/entrypoints/popup/PreAlertList';
import type { NoticeBrowser } from '@/lib/candidate-notice';
import {
  PRE_ALERT_NOTICE_ID,
  announcePreAlerts,
  notifiedPreAlertsItem,
  onPreAlertClicked,
  preAlertNotice,
  preAlertsItem,
} from '@/lib/pre-alert-notice';
import { DEFAULT_WEB_URL } from '@/lib/web-url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alert = (key: string, content = '확장 지원 = 크롬 우선', candidates = 1): PreAlertSummary => ({
  key,
  topicKey: '확장 지원',
  decisions: [{ id: `t-${key}`, topic_key: '확장 지원', content }],
  candidates,
});

function fakeApi() {
  const create = vi.fn<NoticeBrowser['notifications']['create']>(async () => 'id');
  const clear = vi.fn<NoticeBrowser['notifications']['clear']>(async () => true);
  const openTab = vi.fn<NoticeBrowser['tabs']['create']>(async () => ({}));
  const api: NoticeBrowser = {
    notifications: { create, clear, onClicked: { addListener: vi.fn() } },
    tabs: { create: openTab },
    runtime: { getURL: (path) => `chrome-extension://syncup${path}` },
  };
  return { api, create, clear, openTab };
}

beforeEach(() => fakeBrowser.reset());

describe('미리 알림 문구', () => {
  it('팀 결정을 넣어 "이 후보는 팀 결정 …과 어긋나요(미리 알림)"으로 쓴다', () => {
    expect(preAlertText(alert('a'))).toBe("이 후보는 팀 결정 '확장 지원 = 크롬 우선'과 어긋나요(미리 알림)");
    expect(preAlertText(alert('a', '타깃 = 대학교'))).toBe("이 후보는 팀 결정 '타깃 = 대학교'와 어긋나요(미리 알림)");
  });

  it('여러 팀 결정과 어긋나면 첫 결정 외 건수를 붙인다', () => {
    const two = { decisions: [...alert('a').decisions, { id: 't2', topic_key: '확장 지원', content: '확장 지원 = 엣지 포함' }] };
    expect(preAlertText(two)).toBe("이 후보는 팀 결정 '확장 지원 = 크롬 우선' 외 1건과 어긋나요(미리 알림)");
  });

  it('과/와는 끝 글자의 받침으로 고르고, 읽는 법을 모르는 글자면 둘 다 쓴다', () => {
    expect(gwaWa('발표 = 2분')).toBe('과');
    expect(gwaWa('리허설 = 금요일 19')).toBe('와'); // 구
    expect(gwaWa('회의 = 3')).toBe('과'); // 삼
    expect(gwaWa('웹 = Next.js')).toBe('과(와)');
    expect(gwaWa('발표 = (회의 자료).')).toBe('와'); // 문장부호는 건너뛴다
  });
});

describe('announcePreAlerts', () => {
  it('처음 보는 key 만 알리고, 같은 key 는 다시 알리지 않는다', async () => {
    const { api, create } = fakeApi();
    expect(await announcePreAlerts([alert('a')], api)).toBe(true);
    expect(create).toHaveBeenCalledWith(PRE_ALERT_NOTICE_ID, {
      type: 'basic',
      iconUrl: 'chrome-extension://syncup/icon/128.png',
      title: '싱크업 미리 알림: 확장 지원',
      message: "이 후보는 팀 결정 '확장 지원 = 크롬 우선'과 어긋나요(미리 알림)",
    });
    expect(await announcePreAlerts([alert('a', undefined, 2)], api)).toBe(false); // 두 번째 대화의 같은 결정
    expect(create).toHaveBeenCalledTimes(1);
    expect(await preAlertsItem.getValue()).toEqual([alert('a', undefined, 2)]);
  });

  it('새 key 가 여러 개면 건수로 한 번 알린다', async () => {
    const { api, create } = fakeApi();
    await announcePreAlerts([alert('a'), alert('b', '타깃 = 대학생')], api);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({ title: '싱크업 미리 알림', message: expect.stringContaining('2건') });
    expect(preAlertNotice([alert('a'), alert('b')]).message).not.toContain('크롬'); // 여러 건 문구에는 결정을 늘어놓지 않는다
  });

  it('옛 수집기(preAlerts 없음)면 빈 목록으로 두고 알리지 않는다', async () => {
    const { api, create } = fakeApi();
    await preAlertsItem.setValue([alert('a')]);
    expect(await announcePreAlerts(undefined, api)).toBe(false);
    expect(await preAlertsItem.getValue()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('알림이 실패해도 던지지 않고, 그 key 는 기억해 되풀이하지 않는다', async () => {
    const { api, create } = fakeApi();
    create.mockRejectedValue(new Error('notifications disabled'));
    expect(await announcePreAlerts([alert('a')], api)).toBe(false);
    expect(await notifiedPreAlertsItem.getValue()).toEqual(['a']);
  });

  it('알림을 누르면 개인 검토함을 열고, 다른 알림은 무시한다', async () => {
    const { api, openTab, clear } = fakeApi();
    await onPreAlertClicked('other', api);
    expect(openTab).not.toHaveBeenCalled();
    await onPreAlertClicked(PRE_ALERT_NOTICE_ID, api);
    expect(openTab).toHaveBeenCalledWith({ url: `${DEFAULT_WEB_URL}/review` });
    expect(clear).toHaveBeenCalledWith(PRE_ALERT_NOTICE_ID);
  });
});

describe('팝업 미리 알림 목록', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('없으면 아무것도 그리지 않는다', async () => {
    await act(() => root.render(createElement(PreAlertList, { alerts: [] })));
    expect(host.textContent).toBe('');
  });

  it('두 건까지 문구를 보이고 나머지는 건수로, 같은 후보가 여러 장이면 그 수를 붙인다', async () => {
    const alerts = [alert('a', undefined, 2), alert('b', '타깃 = 대학생'), alert('c', 'DB = SQLite')];
    await act(() => root.render(createElement(PreAlertList, { alerts })));
    expect(host.textContent).toContain('팀 결정과 어긋나는 후보 3건');
    expect(host.textContent).toContain("이 후보는 팀 결정 '확장 지원 = 크롬 우선'과 어긋나요(미리 알림) · 같은 후보 2개");
    expect(host.textContent).toContain("'타깃 = 대학생'과");
    expect(host.textContent).not.toContain('DB = SQLite');
    expect(host.textContent).toContain('나머지 1건은 개인 검토함에서');
    expect(host.textContent).toContain('나에게만 보이고');
  });
});
