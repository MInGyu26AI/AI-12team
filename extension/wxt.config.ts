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
    description: 'AI 대화에서 팀 결정을 골라 승인한 것만 공유합니다',
    permissions: ['storage', 'nativeMessaging'],
    host_permissions: ['https://chatgpt.com/*'],
  },
});
