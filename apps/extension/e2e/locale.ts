/**
 * e2e 로케일. 뷰어 문구는 브라우저 UI 언어(`chrome.i18n.getUILanguage()`)를 따른다(사용자 요청 2026-10-23). 한국어 문구로
 * 요소·문장을 확인하는 시험은 한국어로 고정한다. Linux Chromium 은 `--lang` 을 무시하고, Playwright `locale` 은
 * `getUILanguage()`·`navigator.language` 모두에 반영된다(실측, Playwright 1.64 번들 Chromium).
 */
export const E2E_LOCALE = 'ko-KR';
