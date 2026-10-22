/**
 * 툴바 저장 메뉴(사용자 요청 2026-10-22): 프린터 아이콘 버튼 하나가 저장 / 다른 이름으로 저장 / (개발 빌드만)
 * downloads 저장 메뉴를 연다. 비활성 조건·키보드(Enter·화살표·Home·End·Esc)·바깥 클릭·화면 안 배치·Ctrl+S 바로 저장을 확인한다.
 * 스토어 빌드에 downloads 저장이 없는 것은 release-smoke.spec.ts 와 verify-dist --release 가 확인한다.
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
 * FSA 피커를 없앤(=저장이 chrome.downloads 로 가는) 뷰어에 문서를 연다. 헤드리스는 피커를 바로 취소하기 때문이다.
 * 메뉴 세 항목(개발 빌드의 downloads 저장 포함)을 보려면 진단 표시(`?diag`)를 켠다(사용자 요청 2026-10-23).
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

test('문서가 없으면 비활성, 아이콘은 인라인 SVG, 이름·제목은 "저장"', async () => {
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
  // 이전 저장 버튼 셋은 툴바에 없고 메뉴 항목으로만 남는다.
  await expect(page.locator('#toolbar > #save, #toolbar > #save-as')).toHaveCount(0);
  await expect(page.locator('#save-menu')).toBeHidden();
  expect(external).toEqual([]);
  await page.close();
});

test('진단 표시가 꺼져 있으면(기본) 메뉴는 두 항목이고 ↑↓ 는 두 항목만 돈다', async () => {
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

test('마우스: 열면 세 항목(개발 빌드, 진단 표시), 바깥을 누르면 닫히고, 항목을 고르면 닫힌 뒤 저장한다', async () => {
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
  // 바깥(문서 영역) 클릭 → 닫힘
  await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
  await expect(menu).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  // 버튼을 다시 누르면 열리고, 한 번 더 누르면 닫힌다.
  await button.click();
  await expect(menu).toBeVisible();
  await button.click();
  await expect(menu).toBeHidden();
  // 저장: 메뉴가 닫히고 저장 판정 → chrome.downloads(FSA 없음) → 상태 줄 "저장됨".
  await button.click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
  expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
  await expect(menu).toBeHidden();
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved');
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['save']);
  await page.close();
});

test('키보드: Enter·↓ 로 열고 ↑↓(순환)·Home·End 로 옮기며 Esc 는 닫고 버튼으로, Enter 로 실행', async () => {
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
  // ↑ 로 열면 마지막 항목, ↓ 로 열면 첫 항목
  await page.keyboard.press('ArrowUp');
  await expect(menu).toBeVisible();
  expect(await focusedId(page)).toBe('save-downloads');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe('save');
  // Enter 로 실행(downloads 저장)
  await page.keyboard.press('End');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Enter'),
  ]);
  await download.path();
  await expect(menu).toBeHidden();
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['downloads']);
  // Tab 은 메뉴를 닫는다.
  await page.locator('#save-menu-button').focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await page.close();
});

test('Ctrl+S 는 메뉴 없이 바로 저장한다(열린 메뉴는 닫는다)', async () => {
  const page = await openViewer();
  await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  await download.path();
  await expect(page.locator('#save-menu')).toBeHidden();
  expect((await saveEvents(page)).map((e) => e.trigger)).toEqual(['ctrl+s']);
  // 메뉴를 연 채로 Ctrl+S: 메뉴가 닫히고 저장한다.
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
  test(`메뉴는 화면 안에 열린다(${width}px, 버튼을 오른쪽 끝에 둔 경우 포함)`, async () => {
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
    // 버튼을 툴바 오른쪽 끝으로 옮겨도 메뉴가 왼쪽으로 비켜 화면 안에 들어온다.
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
