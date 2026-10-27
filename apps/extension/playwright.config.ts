import { defineConfig } from '@playwright/test';

// Server automation: loads the dist extension in Playwright-bundled Chromium with a persistent context (PLAN.md section 8).
// Kept separate from manual verification on real Chrome on Windows (docs/m0-day1-log.md section 9).
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  // Viewer text follows the browser UI language (user request 2026-10-23). The default project uses Korean (e2e/locale.ts); the en project
  // reruns only the toolbar layout tests in English (checks narrow layout and zoom compensation in both languages). i18n.spec.ts covers the English strings themselves.
  projects: [
    { name: 'ko', use: { locale: 'ko-KR' } },
    { name: 'en', use: { locale: 'en-US' }, testMatch: /toolbar-layout\.spec\.ts$/ },
  ],
});
