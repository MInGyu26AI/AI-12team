import { useEffect, useState } from 'react';
import { READ_FAIL_GUIDE, type TabPing, type TabPingResult } from '@/lib/messages';
import { siteForUrl } from '@/lib/sites';
import { Notice } from './Notice';

type TabStatus =
  | { kind: 'checking' }
  | { kind: 'not-chat' } // ChatGPT 탭이 아님
  | { kind: 'no-script' } // 콘텐츠 스크립트 응답 없음 (설치 전에 열린 탭 등)
  | { kind: 'ok'; ping: TabPingResult };

async function checkTab(): Promise<TabStatus> {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active?.id || !siteForUrl(active.url ?? '')) return { kind: 'not-chat' };
  try {
    const ping = (await browser.tabs.sendMessage(active.id, { type: 'ping' } satisfies TabPing)) as TabPingResult;
    return ping ? { kind: 'ok', ping } : { kind: 'no-script' };
  } catch {
    return { kind: 'no-script' };
  }
}

// 지금 탭에서 대화를 읽을 수 있는지 알려 준다
export function TabNotice({ autoCollect }: { autoCollect: boolean }) {
  const [tab, setTab] = useState<TabStatus>({ kind: 'checking' });
  useEffect(() => {
    checkTab().then(setTab);
  }, []);

  if (tab.kind === 'checking') return null;
  if (tab.kind === 'not-chat') return <Notice tone="info">지금 탭은 ChatGPT가 아니에요. 수집은 chatgpt.com 탭에서 동작해요.</Notice>;
  if (tab.kind === 'no-script') return <Notice tone="error">ChatGPT 페이지와 연결이 안 됐어요. 페이지를 새로고침해 주세요.</Notice>;
  const { ping } = tab;
  if (!ping.selector && ping.onConversation)
    return (
      <Notice tone="error">
        {READ_FAIL_GUIDE}. (드래그 후 오른쪽 아래 “선택한 내용 보내기” 또는 우클릭 메뉴)
      </Notice>
    );
  if (!ping.onConversation) return <Notice tone="info">대화를 시작하면 {autoCollect ? '자동으로' : '“싱크업에 보내기” 버튼으로'} 수집해요.</Notice>;
  return (
    <Notice tone="ok">
      이 대화에서 메시지 {ping.messageCount}개를 읽을 수 있어요
      {ping.guessedRoles > 0 && ` (그중 ${ping.guessedRoles}개는 누가 말했는지 순서로 추정)`}.
      {!autoCollect && ' 화면 오른쪽 아래 버튼으로 보낼 수 있어요.'}
    </Notice>
  );
}
