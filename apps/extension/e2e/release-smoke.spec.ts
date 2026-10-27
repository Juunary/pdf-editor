/**
 * Release staging smoke (contract D6·D7): loads out/release/staging made by `pnpm package` as an unpacked extension and checks
 * open, render and save of a PDF served over http, plus properties of the store build (no DNR, host permissions or WAR; diagnostics UI hidden; no save-to-downloads menu item;
 * about dialog).
 */
import { chromium, expect, test, type BrowserContext, type Frame } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';

const EXT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGING = join(EXT_ROOT, 'out', 'release', 'staging');
const SAMPLE = fileURLToPath(new URL('../../../fixtures/m0/m0-sample.pdf', import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(join(EXT_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

let context: BrowserContext;
let server: Server;
let base: string;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  // Package creation (store build → staging → zip → verify-dist --release).
  const built = spawnSync('pnpm', ['run', 'package'], { cwd: EXT_ROOT, encoding: 'utf8' });
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);

  const pdf = readFileSync(SAMPLE);
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/sample.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
    } else if (path === '/framer.html') {
      // A web page tries to show the extension viewer in an iframe (D7 risk): it must be blocked because there is no WAR.
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<iframe id="f" src="chrome-extension://${extensionId}/viewer.html?file=${base}/sample.pdf"></iframe>`,
        );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-release-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: E2E_LOCALE,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${STAGING}`, `--load-extension=${STAGING}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

async function openSample(init?: () => void): Promise<Frame> {
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await page.goto(`${base}/sample.pdf`);
  const prefix = `chrome-extension://${extensionId}/viewer.html`;
  await expect.poll(() => page.frames().filter((f) => f.url().startsWith(prefix)).length).toBe(1);
  return page.frames().find((f) => f.url().startsWith(prefix))!;
}

test('staging extension: store manifest, no DNR service worker path', async () => {
  const sw = context.serviceWorkers()[0]!;
  const info = await sw.evaluate(() => ({
    manifest: chrome.runtime.getManifest(),
    hasDnr: 'declarativeNetRequest' in chrome,
    hasMimeHandler: typeof chrome.mimeHandler === 'object',
    name: chrome.i18n.getMessage('appName'),
    description: chrome.i18n.getMessage('appDescription'),
    actionTitle: chrome.i18n.getMessage('actionTitle'),
  }));
  // The name and description are _locales messages (user decision 2026-10-26). getManifest() returns the resolved value. Linux Chromium picks the message language from the
  // LANGUAGE environment variable (Playwright locale is not reflected, measured), so here only check that it is one of the two languages. The per-language
  // display is checked by i18n.spec.ts by changing LANGUAGE.
  const locales = (['en', 'ko'] as const).map(
    (lang) =>
      JSON.parse(readFileSync(join(STAGING, '_locales', lang, 'messages.json'), 'utf8')) as Record<
        string,
        { message: string }
      >,
  );
  expect(info.manifest.name).toBe('PDF Editor');
  expect(info.manifest.default_locale).toBe('en');
  expect(info.name).toBe('PDF Editor');
  expect(locales.map((m) => m.appDescription!.message)).toContain(info.description);
  expect(locales.map((m) => m.actionTitle!.message)).toContain(info.actionTitle);
  expect(info.manifest.description).toBe(info.description);
  expect(info.manifest.action?.default_title).toBe(info.actionTitle);
  expect(info.manifest.version).toBe(VERSION);
  expect(info.manifest.minimum_chrome_version).toBe('151');
  expect(info.manifest.permissions).toEqual(['downloads']);
  expect(info.manifest.host_permissions).toBeUndefined();
  expect(info.manifest.web_accessible_resources).toBeUndefined();
  expect(info.hasDnr).toBe(false);
  expect(info.hasMimeHandler).toBe(true);
});

test('open, render, save: top-level MIME handler, diagnostics UI hidden, no save-to-downloads menu item', async () => {
  // Remove the picker as in a context where FSA is unavailable (headless cancels the picker immediately): save → chrome.downloads fallback.
  const frame = await openSample(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  const ink = await frame.evaluate(() => {
    const c = document.getElementById('page-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i]! < 200 || d[i + 1]! < 200 || d[i + 2]! < 200) n++;
    return n;
  });
  expect(ink).toBeGreaterThan(5000);

  // The diagnostics panel and diagnostics button are in the DOM but not visible.
  await expect(frame.locator('html')).toHaveAttribute('data-build', 'store');
  await expect(frame.locator('#diag')).toBeHidden();
  await expect(frame.locator('#bench-full-save')).toBeHidden();
  // The bench measurement page is development-build only (D6): there is no link.
  expect(await frame.locator('#open-bench').count()).toBe(0);
  expect(await frame.locator('#diag').count()).toBe(1);

  // Save menu (user request 2026-10-22): the store build has no save-to-downloads (M0 diagnostics) item.
  expect(await frame.locator('#save-downloads').count()).toBe(0);
  await frame.click('#save-menu-button');
  await expect(frame.locator('#save-menu [role="menuitem"]')).toHaveText([
    /^\s*저장\s*Ctrl\+S\s*$/,
    '다른 이름으로 저장',
  ]);

  // Save: there is no FSA picker, so it saves through chrome.downloads. The document has no edits, so the size equals the original.
  const page = frame.page();
  const [download] = await Promise.all([page.waitForEvent('download'), frame.click('#save')]);
  expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
  await expect(frame.locator('#save-menu')).toBeHidden();
});

test('header area zoom correction: reads and follows the tab zoom without adding permissions (permissions = downloads)', async () => {
  const frame = await openSample();
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  // chrome.tabs.getZoom must work without permission to yield 'tabs' (if it fails, the dpr estimate 'dpr').
  await expect(frame.locator('html')).toHaveAttribute('data-zoom-mode', 'tabs');
  const tabId = await frame.evaluate(async () => (await chrome.mimeHandler.getStreamInfo()).tabId);
  const sw = context.serviceWorkers()[0]!;
  const header = () =>
    frame.evaluate(() => {
      const r = document.getElementById('toolbar')!.getBoundingClientRect();
      return {
        physHeight: Math.round(r.height * devicePixelRatio),
        dpr: devicePixelRatio,
        zoom: document.documentElement.dataset.zoom,
      };
    });
  const before = await header();
  try {
    await sw.evaluate((id) => chrome.tabs.setZoom(id, 2), tabId);
    await expect.poll(header).toMatchObject({ dpr: 2, zoom: '2' });
    expect(Math.abs((await header()).physHeight - before.physHeight)).toBeLessThanOrEqual(1);
  } finally {
    await sw.evaluate((id) => chrome.tabs.setZoom(id, 0), tabId);
  }
});

test('about dialog: version, license, version-tag source link, notices', async () => {
  const frame = await openSample();
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  await frame.click('#about');
  const dialog = frame.locator('#app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`버전 ${VERSION}`);
  await expect(dialog).toContainText('AGPL-3.0-or-later');
  await expect(dialog.locator('a', { hasText: '소스 코드' })).toHaveAttribute(
    'href',
    `https://github.com/Juunary/pdf-editor/tree/v${VERSION}`,
  );
  const notices = dialog.locator('a', { hasText: '서드파티' });
  await expect(notices).toHaveAttribute(
    'href',
    `chrome-extension://${extensionId}/THIRD_PARTY_NOTICES.txt`,
  );
  const text = await frame.evaluate(
    async (url) => (await fetch(url)).text(),
    `chrome-extension://${extensionId}/THIRD_PARTY_NOTICES.txt`,
  );
  expect(text).toContain('mupdf 1.28.1');
  expect(text).toContain('SIL OPEN FONT LICENSE');
});

test('a web page cannot show the extension viewer in an iframe (no WAR, D7)', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/framer.html`);
  await page.waitForTimeout(1500);
  const loaded = page
    .frames()
    .filter((f) => f.url().startsWith(`chrome-extension://${extensionId}/viewer.html`));
  // The blocked frame remains as an error page.
  expect(page.frames().some((f) => f.url().startsWith('chrome-error://'))).toBe(true);
  expect(loaded).toHaveLength(0);
});
