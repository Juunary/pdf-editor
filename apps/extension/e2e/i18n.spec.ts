/**
 * 헤더 언어(사용자 요청 2026-10-23): 브라우저 UI 언어(`chrome.i18n.getUILanguage()`)가 ko 계열이면 한국어, 그 밖은 영어.
 * 영어 로케일(en-US)과 그 밖의 언어(ja-JP)에서 툴바·검색창·저장 메뉴·상태 줄·알림 줄·정보와 저장 확인 대화상자가 영어이고,
 * 한국어 로케일은 한국어인지 확인한다. 로케일은 Playwright `locale`(Linux Chromium 은 `--lang` 을 무시한다, e2e/locale.ts).
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

interface Env {
  context: BrowserContext;
  extensionId: string;
}

async function withLocale(locale: string, fn: (env: Env) => Promise<void>): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-i18n-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await fn({ context, extensionId: new URL(sw.url()).host });
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** 문서를 연 뷰어(`?e2e`, FSA 피커 없음 → 저장은 chrome.downloads). beforeOpen 은 파일을 고르기 전 이음매 손보기. */
async function openViewer(
  env: Env,
  width = 1280,
  beforeOpen?: (page: Page) => Promise<void>,
): Promise<Page> {
  const page = await env.context.newPage();
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.goto(`chrome-extension://${env.extensionId}/viewer.html?e2e`);
  await page.waitForFunction(() => '__pe' in window);
  await beforeOpen?.(page);
  await page.setInputFiles('#open-file', SAMPLE);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  await expect(page.locator('#pe-doc-undo')).toBeVisible();
  return page;
}

/** 머리 영역(툴바·알림 줄·검색창·저장 메뉴)의 보이는 글자와 title·aria-label·placeholder. */
function headerTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const root of [
      document.getElementById('toolbar'),
      document.getElementById('notice-bar'),
    ]) {
      if (!root) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (el && el.getClientRects().length > 0 && n.textContent!.trim() !== '') {
          out.push(n.textContent!.trim());
        }
      }
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        if (el.getClientRects().length === 0) continue;
        for (const a of ['title', 'aria-label', 'placeholder']) {
          const v = el.getAttribute(a);
          if (v) out.push(v);
        }
      }
    }
    return out;
  });
}

const plan = (heap: Record<string, unknown>) => ({
  method: 'full',
  options: 'garbage=yes,compress,objstms',
  reason: 'test',
  canBeSavedIncrementally: false,
  heap: {
    inputBytes: 100 * 2 ** 20,
    ratio: 8,
    estimatedPeakBytes: 1600 * 2 ** 20,
    limitBytes: 2048 * 2 ** 20,
    fraction: 0.78,
    level: 'ok',
    // core 힙 문구는 한국어다. 영어 화면은 이 문구 대신 수치로 문구를 만든다.
    message: '예상 피크 WASM 힙 1600 MiB 가 상한 2048 MiB 의 78% 입니다.',
    ...heap,
  },
  edits: null,
});

test('영어 로케일(en-US): 툴바·검색창·저장 메뉴·쪽 화살표가 영어이고 머리 영역에 한글이 없다', async () => {
  await withLocale('en-US', async (env) => {
    const page = await openViewer(env);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#pe-controls')).toHaveAttribute('aria-label', 'Page navigation');
    await expect(page.locator('#pe-prev')).toHaveAttribute('aria-label', 'Previous page');
    await expect(page.locator('#pe-next')).toHaveAttribute('aria-label', 'Next page');
    await expect(page.locator('#pe-page-input')).toHaveAttribute('aria-label', 'Page number');
    await expect(page.locator('#pe-page-count')).toHaveText('/ 1');
    await expect(page.locator('#pe-find-toggle')).toHaveText('Find');
    await expect(page.locator('#pe-find-toggle')).toHaveAttribute(
      'title',
      'Find in document (Ctrl+F)',
    );
    await expect(page.locator('#pe-overlay-toggle')).toHaveText('Layout & editable marks');
    await expect(page.locator('#pe-doc-undo')).toHaveText('Undo');
    await expect(page.locator('#pe-doc-redo')).toHaveText('Redo');
    await expect(page.locator('#pe-fb-toggle')).toHaveText('Show fallback');
    await expect(page.locator('label.pe-edit-opt')).toHaveText('Block tagged PDF edits');
    await expect(page.locator('#save-menu-button')).toHaveAttribute('aria-label', 'Save');
    await expect(page.locator('#save-menu-button')).toHaveAttribute('title', 'Save');
    await expect(page.locator('#about')).toHaveText('About');
    await expect(page.locator('#open-label')).toContainText('Open PDF');
    await expect(page.locator('#pe-arrow-prev')).toHaveAttribute('aria-label', 'Previous page');
    await expect(page.locator('#pe-arrow-next')).toHaveAttribute('aria-label', 'Next page');

    // 저장 메뉴
    await page.click('#save-menu-button');
    await expect(page.locator('#save')).toHaveText(/^\s*Save\s*Ctrl\+S\s*$/);
    await expect(page.locator('#save-as')).toHaveText('Save as');
    for (const s of await headerTexts(page)) expect(s, '저장 메뉴').not.toMatch(HANGUL);
    await page.keyboard.press('Escape');

    // 검색창: 결과 없음·이전/다음·대소문자·닫기
    await page.keyboard.press('Control+f');
    await expect(page.locator('#pe-find-input')).toHaveAttribute('placeholder', 'Find in document');
    await page.locator('#pe-find-input').fill('zzqqxx');
    await expect(page.locator('#pe-find-count')).toHaveText('No results');
    await expect(page.locator('#pe-find-prev')).toHaveAttribute('aria-label', 'Previous match');
    await expect(page.locator('#pe-find-next')).toHaveAttribute('aria-label', 'Next match');
    await expect(page.locator('#pe-find-case')).toHaveAttribute('aria-label', 'Match case');
    await expect(page.locator('#pe-find-close')).toHaveAttribute('aria-label', 'Close find bar');
    for (const s of await headerTexts(page)) expect(s, '툴바·검색창').not.toMatch(HANGUL);
    await page.close();
  });
});

test('영어 로케일: 알림 줄·상태 줄·저장 확인·정보 대화상자가 영어다', async () => {
  await withLocale('en-US', async (env) => {
    // 알림 줄: 크기 안내(열린 바이트 800 MiB)·Redact 보고
    const page = await openViewer(env, 1280, async (p) => {
      await p.evaluate(() => {
        const pdf = (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf;
        const real = (pdf.open as (b: ArrayBuffer) => Promise<Record<string, unknown>>).bind(pdf);
        pdf.open = async (b: ArrayBuffer) => ({ ...(await real(b)), byteLength: 800 * 2 ** 20 });
        pdf.listRedactAnnots = async () => ({ total: 2, pages: [0, 3] });
      });
    });
    const size = page.locator('#notice-bar [data-notice="size"]');
    await expect(size).toContainText('exceeds the supported size of 790 MiB');
    const redact = page.locator('#notice-bar [data-notice="redact"]');
    await expect(redact).toContainText('2 unapplied Redact annotation(s) (page 1, 4)');
    await expect(redact.locator('button')).toHaveAttribute('title', 'Close');
    for (const s of await headerTexts(page)) expect(s, '알림 줄').not.toMatch(HANGUL);

    // 저장 확인 대화상자(warn): core 한국어 문구 대신 영어 문구, 버튼 Cancel·Save
    await page.evaluate(
      (p) => {
        (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf.planSave =
          async () => p;
      },
      plan({ level: 'warn' }),
    );
    await page.click('#save-menu-button');
    await page.click('#save');
    const dialog = page.locator('#app-dialog');
    await expect(dialog.locator('h2')).toHaveText('Before saving');
    await expect(dialog).toContainText('Saving is expected to use a lot of memory');
    await expect(dialog.locator('[data-dialog-button="cancel"]')).toHaveText('Cancel');
    await expect(dialog.locator('[data-dialog-button="ok"]')).toHaveText('Save');
    expect(await dialog.textContent()).not.toMatch(HANGUL);
    await dialog.locator('[data-dialog-button="cancel"]').click();
    await expect(page.locator('#status')).toHaveText('Save cancelled');

    // 저장(FSA 없음 → 다운로드): 상태 줄 "Saved: Downloads"
    await page.evaluate((p) => {
      (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf.planSave =
        async () => p;
    }, plan({}));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    await download.path();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved');
    await expect(page.locator('#status')).toHaveText('Saved: Downloads');

    // 정보 대화상자
    await page.click('#about');
    await expect(dialog.locator('h2')).toHaveText('About PDF Editor');
    await expect(dialog).toContainText('Version ');
    await expect(dialog.locator('a').first()).toContainText('Source code (v');
    await expect(dialog.locator('[data-dialog-button="ok"]')).toHaveText('Close');
    expect(await dialog.textContent()).not.toMatch(HANGUL);
    await page.close();
  });
});

test('그 밖의 언어(ja-JP)는 영어, 한국어 로케일(ko-KR)은 한국어', async () => {
  await withLocale('ja-JP', async (env) => {
    const page = await openViewer(env);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#pe-find-toggle')).toHaveText('Find');
    await page.close();
  });
  await withLocale('ko-KR', async (env) => {
    const page = await openViewer(env);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('#pe-find-toggle')).toHaveText('찾기');
    await expect(page.locator('#pe-overlay-toggle')).toHaveText('레이아웃·편집 표시');
    await expect(page.locator('#about')).toHaveText('정보');
    await page.click('#save-menu-button');
    await expect(page.locator('#save-as')).toHaveText('다른 이름으로 저장');
    await page.close();
  });
});
