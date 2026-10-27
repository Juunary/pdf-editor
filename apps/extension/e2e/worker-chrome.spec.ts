/**
 * Checks whether chrome.* works in the extension viewer's dedicated Worker and whether bundled assets (fallback fonts) can be fetched
 * (contract 5.7: "whether chrome.* is usable in a dedicated Worker is confirmed by S4"). The result is recorded in docs/m3-viewer-ui.md section 4.
 *
 * Probe: dist/diag/chrome-probe-worker.js (classic dedicated Worker). The real pdf-worker uses the same approach (dedicated module Worker,
 * created by the extension page), so the environment is the same. The fallback font is found by its hashed file name in dist/assets.
 */
import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

test('dedicated Worker: chrome.* unavailable, extension assets (fallback font) fetchable', async () => {
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
    // chrome.* works in the same extension page (control).
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
