import { defineConfig } from '@playwright/test';

// 서버 자동화: Playwright 번들 Chromium + persistent context 로 dist 확장을 로드한다(PLAN.md 8절).
// Windows 실제 Chrome 수동 검증과 구분한다(docs/m0-day1-log.md 9절).
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  // 뷰어 문구는 브라우저 UI 언어를 따른다(사용자 요청 2026-10-23). 기본 프로젝트는 한국어(e2e/locale.ts), en 프로젝트는
  // 툴바 배치 시험만 영어로 한 번 더 돌린다(두 언어에서 좁은 배치·확대 보정 확인). 영어 문구 자체는 i18n.spec.ts 가 본다.
  projects: [
    { name: 'ko', use: { locale: 'ko-KR' } },
    { name: 'en', use: { locale: 'en-US' }, testMatch: /toolbar-layout\.spec\.ts$/ },
  ],
});
