/**
 * e2e locale. Viewer text follows the browser UI language (`chrome.i18n.getUILanguage()`) (user request 2026-10-23). Tests that check elements
 * and sentences by their Korean text pin the locale to Korean. Linux Chromium ignores `--lang`, and Playwright `locale` is
 * reflected in both `getUILanguage()` and `navigator.language` (measured, Playwright 1.64 bundled Chromium).
 */
export const E2E_LOCALE = 'ko-KR';
