import { defineConfig } from 'vitest/config';

// 단위 테스트만. e2e/*.spec.ts 는 Playwright 가 실행한다.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
