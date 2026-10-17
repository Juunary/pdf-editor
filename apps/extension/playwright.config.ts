import { defineConfig } from '@playwright/test';

// 서버 자동화: Playwright 번들 Chromium + persistent context 로 dist 확장을 로드한다(PLAN.md 8절).
// Windows 실제 Chrome 수동 검증과 구분한다(docs/m0-day1-log.md 9절).
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
});
