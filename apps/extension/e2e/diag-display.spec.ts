/**
 * 개발 표시 숨김(사용자 요청 2026-10-23): 진단 패널(#diag "M0 진단", 벤치 링크·전체 저장 측정 포함), 저장 메뉴의 downloads
 * 저장, 상태 줄의 렌더 경과("N 페이지 · 1페이지 렌더 완료")는 개발 빌드에서도 기본으로 숨긴다. `?diag` 로 열거나
 * Ctrl+Alt+Shift+D 를 누르면 보인다(다시 누르면 숨김). 진단 기록 수집과 `#diag-log` 내용은 숨겨져 있어도 그대로다.
 * 스토어 빌드에서 진단 패널이 늘 숨겨지는 것은 release-smoke.spec.ts 가 본다.
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

test('기본: 진단 패널·downloads 저장·렌더 경과 상태가 보이지 않고 진단 기록은 쌓인다', async () => {
  const page = await openViewer();
  await expect(page.locator('html')).not.toHaveAttribute('data-diag', /.*/);
  await expect(page.locator('#diag')).toBeHidden();
  await expect(page.locator('#copy-diag')).toBeHidden();
  await expect(page.locator('#open-bench')).toBeHidden();
  await expect(page.locator('#bench-full-save')).toBeHidden();
  // 렌더 경과 상태는 자리만 차지하고(정보 버튼은 오른쪽 끝) 보이지 않는다.
  await expect(page.locator('#status')).toHaveAttribute('data-dev', '');
  await expect(page.locator('#status')).toHaveCSS('visibility', 'hidden');
  await page.click('#save-menu-button');
  await expect(page.locator('#save-as')).toBeVisible();
  await expect(page.locator('#save-downloads')).toBeHidden();
  await page.keyboard.press('Escape');
  // 진단 기록 수집은 그대로(e2e 는 숨겨진 #diag-log 를 읽는다).
  const events = await diagEvents(page);
  expect(events).toContain('env');
  expect(events).toContain('open');
  expect(events).toContain('render');
  // 문서 영역이 창 아래까지 쓴다(진단 패널 자리 없음).
  const area = await page.evaluate(() => ({
    bottom: document.getElementById('page-container')!.getBoundingClientRect().bottom,
    vh: document.documentElement.clientHeight,
  }));
  expect(area.bottom).toBeGreaterThanOrEqual(area.vh - 0.5);
  await page.close();
});

test('?diag 로 열면 진단 표시가 켜진다', async () => {
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

test('Ctrl+Alt+Shift+D 로 켜고 다시 누르면 숨긴다', async () => {
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
