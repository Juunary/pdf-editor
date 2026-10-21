import { defineConfig } from 'vitest/config';

// 단위 테스트만. e2e/*.spec.ts 는 Playwright 가 실행한다.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_KIND__: JSON.stringify('dev'),
    __SOURCE_URL__: JSON.stringify('https://example.invalid/tree/v0.0.0-test'),
  },
  test: { include: ['test/**/*.test.ts'] },
});
