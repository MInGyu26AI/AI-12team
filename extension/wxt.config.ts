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
    description: 'AI 대화에서 팀 결정을 골라 내가 승인한 것만 팀에 공유합니다',
    // 최소 권한: 콘텐츠 스크립트 주입은 content_scripts.matches 로 충분해서 host_permissions 는 두지 않음
    // tabs = 팝업에서 현재 탭이 ChatGPT 인지 확인, nativeMessaging = 로컬 수집기 연결,
    // contextMenus = 우클릭 "싱크업에 선택한 내용 보내기"
    permissions: ['storage', 'tabs', 'nativeMessaging', 'contextMenus'],
  },
});
