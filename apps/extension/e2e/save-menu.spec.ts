/**
 * Toolbar save menu (user request 2026-10-22): a single printer-icon button opens a menu of Save / Save as / (development builds only)
 * save to downloads. Checks the disabled condition, keyboard (Enter, arrows, Home, End, Esc), outside click, on-screen placement and Ctrl+S direct save.
 * That the store build has no save-to-downloads item is checked by release-smoke.spec.ts and verify-dist --release.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
  userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-savemenu-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: E2E_LOCALE,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

/**
 * Opens a document in a viewer with the FSA picker removed (= saving goes through chrome.downloads), because headless cancels the picker immediately.
 * To see all three menu items (including save to downloads in development builds), turn on the diagnostics display (`?diag`) (user request 2026-10-23).
 */
async function openViewer(width = 1280, height = 800, diag = true): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e${diag ? '&diag' : ''}`);
  await page.setInputFiles('#open-file', SAMPLE);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  return page;
}

async function saveEvents(page: Page): Promise<{ trigger: string; channel: string }[]> {
  const log = JSON.parse((await page.textContent('#diag-log')) ?? '[]') as {
    event: string;
    data: { trigger: string; channel: string };
  }[];
  return log.filter((e) => e.event === 'save').map((e) => e.data);
}

const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? null);

test('disabled without a document, icon is an inline SVG, name and title are "저장"', async () => {
  const page = await context.newPage();
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('chrome-extension://')) external.push(r.url());
  });
  await page.goto(`chrome-extension://${extensionId}/viewer.html`);
  const button = page.locator('#save-menu-button');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-label', '저장');
  await expect(button).toHaveAttribute('title', '저장');
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await expect(button.locator('svg')).toHaveCount(1);
  expect(await button.locator('img, use, image').count()).toBe(0);
  // The old set of save buttons is gone from the toolbar and remains only as menu items.
  await expect(page.locator('#toolbar > #save, #toolbar > #save-as')).toHaveCount(0);
  await expect(page.locator('#save-menu')).toBeHidden();
  expect(external).toEqual([]);
  await page.close();
});

test('when the diagnostics display is off (default) the menu has two items and ↑↓ cycle through only those two', async () => {
  const page = await openViewer(1280, 800, false);
  const menu = page.locator('#save-menu');
  await page.locator('#save-menu-button').focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(page.locator('#save-downloads')).toBeHidden();
  const visible = await menu
    .locator('[role="menuitem"]')
    .evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => e.id));
  expect(visible).toEqual(['save', 'save-as']);
  await page.keyboard.press('ArrowUp');
  expect(await focusedId(page)).toBe('save-as');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('save');
  await page.keyboard.press('Escape');
  await page.close();
});

test('mouse: opening shows three items (development build, diagnostics display), clicking outside closes, choosing an item closes then saves', async () => {
  const page = await openViewer();
  const button = page.locator('#save-menu-button');
  const menu = page.locator('#save-menu');
  await button.click();
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.locator('[role="menuitem"]')).toHaveText([
    /^\s*저장\s*Ctrl\+S\s*$/,
    '다른 이름으로 저장',
    'downloads 저장',
  ]);
  // Click outside (document area) → closes
  await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
  await expect(menu).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  // Pressing the button again opens it, and pressing once more closes it.
  await button.click();
  await expect(menu).toBeVisible();
  await button.click();
  await expect(menu).toBeHidden();
  // Save: the menu closes and the save classification → chrome.downloads (no FSA) → status line "저장됨".
  await button.click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
  await expect(menu).toBeHidden();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved');
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['save']);
  await page.close();
});

test('keyboard: open with Enter/↓, move with ↑↓ (cycling)/Home/End, Esc closes and returns to the button, Enter executes', async () => {
  const page = await openViewer();
  const menu = page.locator('#save-menu');
  await page.locator('#save-menu-button').focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  expect(await focusedId(page)).toBe('save');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('save-as');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('save-downloads');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('save');
  await page.keyboard.press('ArrowUp');
  expect(await focusedId(page)).toBe('save-downloads');
  await page.keyboard.press('Home');
  expect(await focusedId(page)).toBe('save');
  await page.keyboard.press('End');
  expect(await focusedId(page)).toBe('save-downloads');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await focusedId(page)).toBe('save-menu-button');
  // Opening with ↑ gives the last item, opening with ↓ gives the first item
  await page.keyboard.press('ArrowUp');
  await expect(menu).toBeVisible();
  expect(await focusedId(page)).toBe('save-downloads');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('save');
  // Execute with Enter (save to downloads)
  await page.keyboard.press('End');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Enter'),
  ]);
  await download.path();
  await expect(menu).toBeHidden();
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['downloads']);
  // Tab closes the menu.
  await page.locator('#save-menu-button').focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await page.close();
});

test('Ctrl+S saves directly without the menu (an open menu is closed)', async () => {
  const page = await openViewer();
  await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  await download.path();
  await expect(page.locator('#save-menu')).toBeHidden();
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['ctrl+s']);
  // Ctrl+S with the menu open: the menu closes and the save runs.
  await page.click('#save-menu-button');
  await expect(page.locator('#save-menu')).toBeVisible();
  const [second] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  await second.path();
  await expect(page.locator('#save-menu')).toBeHidden();
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['ctrl+s', 'ctrl+s']);
  await page.close();
});

for (const width of [320, 400, 1280]) {
  test(`the menu opens inside the screen (${width}px, including when the button is at the right end)`, async () => {
    const page = await openViewer(width, 700);
    const inViewport = async (tag: string) => {
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      const vh = await page.evaluate(() => document.documentElement.clientHeight);
      const m = await page.locator('#save-menu').boundingBox();
      expect(m, tag).not.toBeNull();
      expect(m!.x, `${tag} left`).toBeGreaterThanOrEqual(-0.5);
      expect(m!.x + m!.width, `${tag} right`).toBeLessThanOrEqual(vw + 0.5);
      expect(m!.y + m!.height, `${tag} bottom`).toBeLessThanOrEqual(vh + 0.5);
    };
    await page.click('#save-menu-button');
    await inViewport('기본 위치');
    await page.keyboard.press('Escape');
    // Even if the button is moved to the right end of the toolbar, the menu shifts left and stays inside the screen.
    await page.evaluate(() => {
      const wrap = document.getElementById('save-menu-wrap')!;
      wrap.style.order = '99';
      wrap.style.marginLeft = 'auto';
    });
    await page.click('#save-menu-button');
    await inViewport('오른쪽 끝');
    await page.close();
  });
}
