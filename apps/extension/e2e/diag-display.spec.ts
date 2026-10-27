/**
 * Development display hiding (user request 2026-10-23): the diagnostics panel (#diag "M0 진단", including the bench link and full-save measurement), downloads save in the save menu,
 * and the render-progress status line ("N 페이지 · 1페이지 렌더 완료") are hidden by default, even in development builds. Opening with `?diag` or
 * pressing Ctrl+Alt+Shift+D shows them (pressing again hides them). Diagnostics log collection and the `#diag-log` content stay the same even when hidden.
 * That the diagnostics panel is always hidden in the store build is checked by release-smoke.spec.ts.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-diag-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: E2E_LOCALE,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

async function openViewer(query = ''): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/viewer.html${query}`);
  await page.setInputFiles('#open-file', SAMPLE);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  return page;
}

const diagEvents = async (page: Page) =>
  (JSON.parse((await page.textContent('#diag-log')) ?? '[]') as { event: string }[]).map(
    (e) => e.event,
  );

test('default: diagnostics panel, downloads save and render-progress status are not visible, and the diagnostics log accumulates', async () => {
  const page = await openViewer();
  await expect(page.locator('html')).not.toHaveAttribute('data-diag', /.*/);
  await expect(page.locator('#diag')).toBeHidden();
  await expect(page.locator('#copy-diag')).toBeHidden();
  await expect(page.locator('#open-bench')).toBeHidden();
  await expect(page.locator('#bench-full-save')).toBeHidden();
  // The render-progress status only occupies space (the info button is at the right end) and is not visible.
  await expect(page.locator('#status')).toHaveAttribute('data-dev', '');
  await expect(page.locator('#status')).toHaveCSS('visibility', 'hidden');
  await page.click('#save-menu-button');
  await expect(page.locator('#save-as')).toBeVisible();
  await expect(page.locator('#save-downloads')).toBeHidden();
  await page.keyboard.press('Escape');
  // Diagnostics log collection is unchanged (e2e reads the hidden #diag-log).
  const events = await diagEvents(page);
  expect(events).toContain('env');
  expect(events).toContain('open');
  expect(events).toContain('render');
  // The document area extends to the bottom of the window (no room for the diagnostics panel).
  const area = await page.evaluate(() => ({
    bottom: document.getElementById('page-container')!.getBoundingClientRect().bottom,
    vh: document.documentElement.clientHeight,
  }));
  expect(area.bottom).toBeGreaterThanOrEqual(area.vh - 0.5);
  await page.close();
});

test('opening with ?diag turns the diagnostics display on', async () => {
  const page = await openViewer('?diag');
  await expect(page.locator('html')).toHaveAttribute('data-diag', '');
  await expect(page.locator('#diag')).toBeVisible();
  await expect(page.locator('#diag > summary')).toHaveText('M0 진단');
  await expect(page.locator('#status')).toHaveCSS('visibility', 'visible');
  await expect(page.locator('#status')).toContainText('렌더 완료');
  await page.click('#save-menu-button');
  await expect(page.locator('#save-downloads')).toBeVisible();
  await page.close();
});

test('Ctrl+Alt+Shift+D turns it on and pressing again hides it', async () => {
  const page = await openViewer();
  await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Alt+Shift+KeyD');
  await expect(page.locator('html')).toHaveAttribute('data-diag', '');
  await expect(page.locator('#diag')).toBeVisible();
  await expect(page.locator('#status')).toHaveCSS('visibility', 'visible');
  await page.locator('#diag > summary').click();
  await expect(page.locator('#copy-diag')).toBeVisible();
  await expect(page.locator('#open-bench')).toBeVisible();
  await page.keyboard.press('Control+Alt+Shift+KeyD');
  await expect(page.locator('#diag')).toBeHidden();
  await expect(page.locator('#status')).toHaveCSS('visibility', 'hidden');
  expect((await diagEvents(page)).filter((e) => e === 'diag-visible')).toHaveLength(2);
  await page.close();
});
