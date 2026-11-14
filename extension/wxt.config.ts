import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

const sharedDir = resolve(__dirname, '../shared');

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  alias: { '@shared': sharedDir },
  vite: () => ({
    plugins: [tailwindcss()],
    server: { fs: { allow: [resolve(__dirname), sharedDir] } },
  }),
  manifest: {
    name: '싱크업 SyncUp',
    description: '프로젝트 대화만 가져오고, 내가 승인한 것만 팀에 공유합니다',
    // host_permissions 는 두지 않는다: 콘텐츠 스크립트 주입은 content_scripts.matches 로 충분하다.
    // 다만 web-bridge 의 matches 는 *.vercel.app 전체와 로컬 개발 주소라 설치 때 그 사이트 접근 권한이 붙는다.
    // web-bridge 는 그중 팝업에서 설정한 주소 하나에서만 답한다 (lib/web-url.ts isTrustedWebOrigin)
    // tabs = 팝업에서 현재 탭이 ChatGPT 인지 확인, nativeMessaging = 로컬 수집기 연결,
    // contextMenus = 우클릭 "싱크업에 선택한 내용 보내기", alarms = 30초마다 로컬 수집기 상태(검토 대기 수·배지) 새로 고침과
    // 1분마다 팀 충돌 확인, notifications = 새 충돌을 윈도우·맥 시스템 알림으로
    permissions: ['storage', 'tabs', 'nativeMessaging', 'contextMenus', 'alarms', 'notifications'],
  },
});
