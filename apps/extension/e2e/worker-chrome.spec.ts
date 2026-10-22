/**
 * 확장 뷰어의 전용 Worker 에서 chrome.* 가 되는지, 번들된 자산(폴백 폰트)을 fetch 할 수 있는지 확인한다
 * (계약 5.7: "전용 Worker 에서 chrome.* 사용 가능 여부는 S4 가 확인"). 결과는 docs/m3-viewer-ui.md 4절에 기록한다.
 *
 * 프로브: dist/diag/chrome-probe-worker.js(클래식 전용 Worker). 실제 pdf-worker 는 같은 방식(전용 module Worker,
 * 확장 페이지가 생성)이므로 같은 환경이다. 폴백 폰트는 dist/assets 의 해시 파일명으로 찾는다.
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

test('전용 Worker: chrome.* 사용 불가, 확장 자산(폴백 폰트) fetch 가능', async () => {
  const fontFile = readdirSync(join(DIST, 'assets')).find((f) =>
    /^NotoSansKR-Regular-subset-.*\.ttf$/.test(f),
  );
  expect(fontFile, 'dist 에 폴백 폰트가 있어야 한다').toBeDefined();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-worker-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: E2E_LOCALE,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html`);
    const report = await page.evaluate(
      (fontUrl) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const worker = new Worker(chrome.runtime.getURL('diag/chrome-probe-worker.js'));
          worker.onmessage = (e) => resolve(e.data as Record<string, unknown>);
          worker.onerror = (e) => reject(new Error(e.message));
          worker.postMessage({ fontUrl: chrome.runtime.getURL(fontUrl) });
        }),
      `assets/${fontFile}`,
    );
    // 같은 확장 페이지에서는 chrome.* 가 된다(대조).
    const pageChrome = await page.evaluate(() => ({
      typeofRuntime: typeof chrome.runtime,
      typeofStorage: typeof chrome.storage,
      typeofDownloads: typeof chrome.downloads,
    }));
    const out = {
      browser: context.browser()?.version() ?? null,
      worker: report,
      extensionPage: pageChrome,
    };
    writeFileSync(test.info().outputPath('worker-chrome.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));

    expect(report.typeofChrome, '전용 Worker 에서 chrome 전역').toBe('undefined');
    expect(report.typeofRuntime).toBe('undefined');
    expect(report.manifestFetch).toEqual({ status: 200 });
    expect(report.fontFetch).toMatchObject({ status: 200, magic: [0, 1, 0, 0] });
    expect((report.fontFetch as { bytes: number }).bytes).toBe(4_082_236);
    expect(pageChrome.typeofRuntime).toBe('object');
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
