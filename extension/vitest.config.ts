import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// wxt.config.ts 의 별칭(@shared 등)과 가짜 browser API(fakeBrowser)로 확장 코드를 시험한다
export default defineConfig({
  plugins: [WxtVitest()],
  test: { include: ['tests/**/*.test.ts'] },
});
