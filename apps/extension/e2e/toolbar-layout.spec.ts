/**
 * Viewer toolbar and document area layout (M5 S3, header area zoom correction user request 2026-10-22).
 *
 * - The toolbar always shows at the very top of the window at the full window width, and only the document area (#page-container) scrolls horizontally and vertically.
 * - Browser zoom in/out is applied through the real tab zoom (`chrome.tabs.setZoom`, the same HostZoomMap path as Ctrl +/−, Ctrl+wheel and the menu).
 *   The on-screen size (getBoundingClientRect × devicePixelRatio) and layout of the header area (toolbar, notice line, find bar) are the same as at 100%, and the document
 *   zooms in and out as usual.
 * - The narrow layout (reduced text and margins, development-only menu items hidden, status line on its own row) turns on only when the window is actually narrow (600px or less converted to 100%).
 * - Embedded contexts (embed, iframe, object) are not corrected (they follow the outer page zoom).
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';
import { showDiag } from './toolbar-helpers.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

let context: BrowserContext;
let sw: Worker;
let server: Server;
let base: string;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  // Serves dist/diag over http (`/sample.pdf` is m0-sample.pdf, the embedded context is embed-test.html).
  server = createServer((req, res) => {
    const name = basename(new URL(req.url ?? '/', 'http://x').pathname);
    let body: Buffer;
    try {
      body = readFileSync(join(DIST, 'diag', name === 'sample.pdf' ? 'm0-sample.pdf' : name));
    } catch {
      res.writeHead(404).end();
      return;
    }
    const type = name.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-toolbar-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    // Project locale (playwright.config.ts: ko by default, en runs the same test with the English toolbar).
    locale: test.info().project.use.locale ?? E2E_LOCALE,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterEach(async () => {
  // The tab zoom is kept per origin (extension origin, test server origin), so restore it before closing the page. Within a test the page is not closed.
  await sw.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) {
      if (t.id !== undefined) await chrome.tabs.setZoom(t.id, 0).catch(() => undefined);
    }
  });
  for (const p of context.pages().slice(1)) await p.close();
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tab id of the tab with the viewer (extension page tabs use getCurrent, the MIME handler uses StreamInfo). */
async function tabIdOf(frame: Frame): Promise<number> {
  return frame.evaluate(async () => {
    const info = await chrome.mimeHandler?.getStreamInfo().catch(() => null);
    return info?.tabId ?? (await chrome.tabs.getCurrent())!.id!;
  });
}

/** Changes the tab zoom (the same path as browser zoom in/out). */
async function setTabZoom(tabId: number, factor: number): Promise<void> {
  await sw.evaluate(([id, f]) => chrome.tabs.setZoom(id, f), [tabId, factor] as const);
}

/** Correction context: until the frame switches to the new zoom (dpr) and the header area correction reflects that zoom. */
async function waitCompensated(frame: Frame, factor: number): Promise<void> {
  await expect
    .poll(() =>
      frame.evaluate(() => ({
        dpr: Math.round(devicePixelRatio * 1000) / 1000,
        zoom: Number(document.documentElement.dataset.zoom),
      })),
    )
    .toEqual({ dpr: factor, zoom: factor });
}

async function openViewer(width: number, height: number, filler = true): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`chrome-extension://${extensionId}/viewer.html?file=${base}/sample.pdf`);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-zoom-mode', 'tabs');
  if (filler) {
    // Mimic a document larger than the window (so it scrolls both horizontally and vertically).
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'test-filler';
      el.style.cssText = 'flex:none;width:3000px;height:3000px';
      document.getElementById('page-container')!.append(el);
    });
  }
  return page;
}

interface PhysBox {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** On-screen (physical px) boxes of the header area: the toolbar and its visible controls inside, the notice line, and the find bar. */
async function headerSnapshot(frame: Frame) {
  return frame.evaluate(() => {
    const d = devicePixelRatio;
    const phys = (el: Element, key: string) => {
      const r = el.getBoundingClientRect();
      return { key, x: r.x * d, y: r.y * d, w: r.width * d, h: r.height * d };
    };
    const shown = (el: Element) => el.getClientRects().length > 0;
    const toolbar = document.getElementById('toolbar')!;
    const items = [
      ...toolbar.querySelectorAll(
        'button, input, label, #status, .pe-page-count, .pe-notice, #pe-find-count',
      ),
    ]
      .filter(shown)
      .map((el, i) => phys(el, `${el.id || el.className || el.tagName}#${i}`));
    const notice = document.getElementById('notice-bar')!;
    return {
      toolbar: phys(toolbar, 'toolbar'),
      notice: notice.hidden ? null : phys(notice, 'notice-bar'),
      items,
      narrow: document.documentElement.hasAttribute('data-narrow'),
    };
  });
}

type Snapshot = Awaited<ReturnType<typeof headerSnapshot>>;

/** The physical boxes of two snapshots are equal within tol (px). */
function expectSameLayout(actual: Snapshot, expected: Snapshot, tag: string, tol = 1) {
  const same = (a: PhysBox | null, b: PhysBox | null, label: string) => {
    expect(a === null, `${tag}: ${label} 표시 여부`).toBe(b === null);
    if (!a || !b) return;
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      expect(
        Math.abs(a[k] - b[k]),
        `${tag}: ${label}.${k} ${a[k].toFixed(2)} vs ${b[k].toFixed(2)}`,
      ).toBeLessThanOrEqual(tol);
    }
  };
  same(actual.toolbar, expected.toolbar, 'toolbar');
  same(actual.notice, expected.notice, 'notice-bar');
  expect(
    actual.items.map((i) => i.key),
    `${tag}: 머리 영역 컨트롤 목록`,
  ).toEqual(expected.items.map((i) => i.key));
  actual.items.forEach((item, i) => same(item, expected.items[i]!, item.key));
  expect(actual.narrow, `${tag}: 좁은 배치`).toBe(expected.narrow);
}

async function pagePhysicalWidth(page: Page): Promise<number> {
  return page.evaluate(
    () => document.getElementById('pe-page')!.getBoundingClientRect().width * devicePixelRatio,
  );
}

async function viewportSize(page: Page) {
  return page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
}

test('zoom 50% and 200%: the on-screen size and layout of the header area equal 100% and the document zooms in/out (1280px)', async () => {
  const page = await openViewer(1280, 800, false);
  const tabId = await tabIdOf(page.mainFrame());
  const base100 = await headerSnapshot(page.mainFrame());
  expect(base100.narrow).toBe(false);
  const doc100 = await pagePhysicalWidth(page);
  const docs: Record<string, number> = {};
  for (const f of [2, 0.5]) {
    await setTabZoom(tabId, f);
    await waitCompensated(page.mainFrame(), f);
    // The document is redrawn at the new zoom (fit to window width, up to 1.5x).
    await expect.poll(() => pagePhysicalWidth(page)).not.toBeCloseTo(doc100, 0);
    docs[f] = await pagePhysicalWidth(page);
    expectSameLayout(await headerSnapshot(page.mainFrame()), base100, `확대 ${f * 100}%`);
    await expect(page.locator('html')).toHaveAttribute('data-zoom-mode', 'tabs');
  }
  expect(docs[2]!, '200%: 쪽이 커진다').toBeGreaterThan(doc100 * 1.05);
  expect(docs[0.5]!, '50%: 쪽이 작아진다').toBeLessThan(doc100 * 0.95);
  // Restoring brings it back unchanged.
  await setTabZoom(tabId, 1);
  await waitCompensated(page.mainFrame(), 1);
  expectSameLayout(await headerSnapshot(page.mainFrame()), base100, '되돌림 100%');
});

test('the narrow layout turns on only from the actual window width: zooming does not turn it on, shrinking the window does regardless of zoom', async () => {
  const page = await openViewer(1000, 700, false);
  const frame = page.mainFrame();
  const tabId = await tabIdOf(frame);
  const wide = await headerSnapshot(frame);
  expect(wide.narrow).toBe(false);
  // 1000px window at 200% (CSS width 500): not the narrow layout, same layout as 100%.
  await setTabZoom(tabId, 2);
  await waitCompensated(frame, 2);
  expectSameLayout(await headerSnapshot(frame), wide, '1000px 200%');
  // Shrinking the window to 400px gives the narrow layout (200% unchanged).
  await page.setViewportSize({ width: 400, height: 700 });
  await expect(page.locator('html')).toHaveAttribute('data-narrow', '');
  const narrow200 = await headerSnapshot(frame);
  // A 400px window at 100% and 50% also gives the same narrow layout.
  for (const f of [1, 0.5]) {
    await setTabZoom(tabId, f);
    await waitCompensated(frame, f);
    expectSameLayout(await headerSnapshot(frame), narrow200, `400px ${f * 100}%`);
  }
  // Narrow layout: the status line on its own row (toolbar inner width), development-only menu items hidden. The render-progress status is a development display, so in the narrow layout
  // it does not take up a row (user request 2026-10-23). The status line width is measured with the diagnostics display on.
  await expect(page.locator('#status')).toBeHidden();
  await showDiag(page);
  const status = (await page.locator('#status').boundingBox()) as Box;
  const toolbar = (await page.locator('#toolbar').boundingBox()) as Box;
  expect(status.width).toBeGreaterThan(toolbar.width * 0.9);
  await page.click('#save-menu-button');
  await expect(page.locator('#save-downloads')).toBeHidden();
  await expect(page.locator('#save')).toBeVisible();
});

const PIN_CONFIGS = [
  { width: 400, height: 700, zoom: 1 },
  { width: 800, height: 700, zoom: 1 },
  { width: 1280, height: 800, zoom: 1 },
  { width: 800, height: 700, zoom: 1.5 },
  { width: 1280, height: 800, zoom: 2 },
  { width: 1280, height: 800, zoom: 0.5 },
  { width: 400, height: 700, zoom: 2 },
];

async function assertToolbarPinned(page: Page, tag: string) {
  const { w, h } = await viewportSize(page);
  const tb = (await page.locator('#toolbar').boundingBox()) as Box;
  expect(tb.y, `${tag}: 툴바 top`).toBeCloseTo(0, 0);
  expect(tb.x, `${tag}: 툴바 left`).toBeCloseTo(0, 0);
  expect(tb.width, `${tag}: 툴바 폭 = 창 폭`).toBeCloseTo(w, 0);
  // The save menu, the info button and every visible element of the toolbar are on screen.
  for (const sel of ['#save-menu-button', '#about']) {
    const box = (await page.locator(sel).boundingBox()) as Box;
    expect(box.x, `${tag}: ${sel} left`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${tag}: ${sel} right`).toBeLessThanOrEqual(w + 0.5);
    expect(box.y + box.height, `${tag}: ${sel} bottom`).toBeLessThanOrEqual(h + 0.5);
  }
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#toolbar *')]
      .map((el) => ({ el: el as HTMLElement, r: el.getBoundingClientRect() }))
      .filter(({ r, el }) => r.width > 0 && el.offsetParent !== null && r.right > w + 0.5)
      .map(({ el }) => el.id || el.className || el.tagName);
  });
  expect(overflow, `${tag}: 창 밖으로 넘친 툴바 요소`).toEqual([]);
}

for (const cfg of PIN_CONFIGS) {
  const tag = `${cfg.width}x${cfg.height} 확대 ${cfg.zoom}`;
  test(`toolbar pinned, only the document area scrolls: ${tag}`, async () => {
    const page = await openViewer(cfg.width, cfg.height);
    if (cfg.zoom !== 1) {
      await setTabZoom(await tabIdOf(page.mainFrame()), cfg.zoom);
      await waitCompensated(page.mainFrame(), cfg.zoom);
    }
    // The narrow layout is decided only by the width converted to 100% (the window width).
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-narrow')), {
        message: `${tag}: 좁은 배치`,
      })
      .toBe(cfg.width <= 600);
    await assertToolbarPinned(page, `${tag} 초기`);

    // Even after scrolling the document area to the end horizontally and vertically, the toolbar stays as is.
    await page.evaluate(() => {
      const c = document.getElementById('page-container')!;
      c.scrollTo(c.scrollWidth, c.scrollHeight);
      window.scrollTo(0, 5000);
    });
    await page.waitForTimeout(100);
    const state = await page.evaluate(() => {
      const c = document.getElementById('page-container')!;
      const doc = document.scrollingElement!;
      return {
        containerScrollable: c.scrollWidth > c.clientWidth && c.scrollHeight > c.clientHeight,
        scrolledX: c.scrollLeft,
        scrolledY: c.scrollTop,
        pageScrollY: doc.scrollTop,
        pageScrollX: doc.scrollLeft,
        pageOverflowX: doc.scrollWidth > doc.clientWidth,
      };
    });
    expect(state.containerScrollable, `${tag}: 문서 영역이 가로·세로로 스크롤 가능`).toBe(true);
    expect(state.scrolledX, tag).toBeGreaterThan(0);
    expect(state.scrolledY, tag).toBeGreaterThan(0);
    expect(state.pageScrollY, `${tag}: 창 자체는 스크롤되지 않음`).toBe(0);
    expect(state.pageScrollX, tag).toBe(0);
    expect(state.pageOverflowX, `${tag}: 창 가로 스크롤 없음`).toBe(false);
    await assertToolbarPinned(page, `${tag} 스크롤 뒤`);

    // Back at the left end, the first element (the left arrow) is not clipped.
    await page.evaluate(() => document.getElementById('page-container')!.scrollTo(0, 0));
    const left = await page.evaluate(() => {
      const c = document.getElementById('page-container')!.getBoundingClientRect();
      return document.getElementById('pe-arrow-prev')!.getBoundingClientRect().left - c.left;
    });
    expect(left, `${tag}: 왼쪽이 잘리지 않음`).toBeGreaterThanOrEqual(-0.5);
  });
}

test('notice line and find bar are also zoom-corrected: on-screen size equals 100% and the find bar is right below the header area', async () => {
  const page = await openViewer(1280, 800, false);
  const frame = page.mainFrame();
  const tabId = await tabIdOf(frame);
  await page.evaluate(() => {
    const bar = document.getElementById('notice-bar')!;
    const row = document.createElement('div');
    row.className = 'notice';
    row.textContent = '알림 '.repeat(40);
    bar.append(row);
    bar.hidden = false;
  });
  await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+f');
  await expect(page.locator('.pe-find')).toBeVisible();
  const findPhys = () =>
    page.evaluate(() => {
      const d = devicePixelRatio;
      const f = document.querySelector('.pe-find')!.getBoundingClientRect();
      const n = document.getElementById('notice-bar')!.getBoundingClientRect();
      return {
        top: f.top * d,
        right: (document.documentElement.clientWidth - f.right) * d,
        w: f.width * d,
        h: f.height * d,
        headerBottom: n.bottom * d,
        inViewport: f.left >= -0.5 && f.right <= document.documentElement.clientWidth + 0.5,
      };
    });
  await expect.poll(async () => (await findPhys()).top).toBeGreaterThan(0);
  const base100 = await headerSnapshot(frame);
  const find100 = await findPhys();
  expect(find100.top - find100.headerBottom).toBeGreaterThanOrEqual(3);
  for (const f of [2, 0.5]) {
    await setTabZoom(tabId, f);
    await waitCompensated(frame, f);
    expectSameLayout(await headerSnapshot(frame), base100, `알림 줄 ${f * 100}%`);
    await expect.poll(async () => Math.abs((await findPhys()).top - find100.top) <= 1.5).toBe(true);
    const find = await findPhys();
    for (const k of ['top', 'right', 'w', 'h', 'headerBottom'] as const) {
      expect(Math.abs(find[k] - find100[k]), `검색창 ${f * 100}% ${k}`).toBeLessThanOrEqual(1.5);
    }
    expect(find.inViewport, `검색창 ${f * 100}% 화면 안`).toBe(true);
  }
});

test('the MIME handler top-level context is also corrected by tab zoom', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${base}/sample.pdf`);
  const prefix = `chrome-extension://${extensionId}/viewer.html`;
  await expect.poll(() => page.frames().filter((f) => f.url().startsWith(prefix)).length).toBe(1);
  const frame = page.frames().find((f) => f.url().startsWith(prefix))!;
  await expect(frame.locator('body')).toHaveAttribute('data-context', 'mime-handler-top');
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  await expect(frame.locator('html')).toHaveAttribute('data-zoom-mode', 'tabs');
  const tabId = await tabIdOf(frame);
  const base100 = await headerSnapshot(frame);
  for (const f of [2, 0.5]) {
    await setTabZoom(tabId, f);
    await waitCompensated(frame, f);
    expectSameLayout(await headerSnapshot(frame), base100, `MIME handler ${f * 100}%`);
  }
});

test('embedded contexts (embed, iframe, object) are not corrected and follow the outer page zoom', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${base}/embed-test.html`);
  const prefix = `chrome-extension://${extensionId}/viewer.html`;
  await expect.poll(() => page.frames().filter((f) => f.url().startsWith(prefix)).length).toBe(3);
  const frames = page.frames().filter((f) => f.url().startsWith(prefix));
  const header = (f: Frame) =>
    f.evaluate(() => ({
      dpr: devicePixelRatio,
      cssWidth: innerWidth,
      zoom: document.documentElement.dataset.zoom,
      cssZoom: getComputedStyle(document.getElementById('toolbar')!).zoom,
      narrow: document.documentElement.hasAttribute('data-narrow'),
    }));
  for (const f of frames) {
    await expect(f.locator('body')).toHaveAttribute('data-context', 'mime-handler-embedded');
    await expect(f.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 30_000,
    });
    await expect(f.locator('html')).toHaveAttribute('data-zoom-mode', 'off');
  }
  await setTabZoom(await tabIdOf(frames[0]!), 2);
  // The viewer frame receives the tab zoom (the timing differs per frame in headless). Even a frame that receives it does not turn on the header area correction
  // (CSS zoom 1): the on-screen size follows the outer zoom, and the narrow layout is still decided by the CSS width.
  await expect
    .poll(async () => (await Promise.all(frames.map(header))).some((s) => s.dpr === 2))
    .toBe(true);
  for (const [i, f] of frames.entries()) {
    // A frame off screen has rendering (resize events) deferred, so bring the outer element on screen before looking.
    await (await f.parentFrame()!.frameElement()).scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const s = await header(f);
        return s.narrow === s.cssWidth <= 600;
      })
      .toBe(true);
    const s = await header(f);
    expect(s.zoom, `프레임 ${i}: 보정 배율`).toBe('1');
    expect(s.cssZoom, `프레임 ${i}: 툴바 CSS zoom`).toBe('1');
    await expect(f.locator('html')).toHaveAttribute('data-zoom-mode', 'off');
  }
});

test('narrow width (400): development-only menu items hidden, status line on its own row, page navigation, save and undo are on screen', async () => {
  const page = await openViewer(400, 700);
  await expect(page.locator('html')).toHaveAttribute('data-narrow', '');
  const { w } = await viewportSize(page);
  for (const sel of ['#pe-page-input', '#pe-doc-undo', '#pe-doc-redo', '#save-menu-button']) {
    const box = await page.locator(sel).boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box!.x + box!.width, `${sel} right`).toBeLessThanOrEqual(w + 0.5);
  }
  // The save menu opens inside the screen, and the development-only save to downloads is hidden.
  await page.click('#save-menu-button');
  await expect(page.locator('#save')).toBeVisible();
  await expect(page.locator('#save-as')).toBeVisible();
  await expect(page.locator('#save-downloads')).toBeHidden();
  const menu = (await page.locator('#save-menu').boundingBox()) as Box;
  expect(menu.x).toBeGreaterThanOrEqual(-0.5);
  expect(menu.x + menu.width).toBeLessThanOrEqual(w + 0.5);
  await page.keyboard.press('Escape');
  await expect(page.locator('#save-menu')).toBeHidden();
  // Even if the toolbar height grows to several rows, the document area remains.
  const c = (await page.locator('#page-container').boundingBox()) as Box;
  expect(c.height).toBeGreaterThan(200);
});

test('wide window (1280): the page sits at the center of the document area', async () => {
  const page = await openViewer(1280, 800, false);
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => {
    const c = document.getElementById('page-container')!.getBoundingClientRect();
    const p = document.getElementById('pe-page')!.getBoundingClientRect();
    return Math.abs(c.left + c.width / 2 - (p.left + p.width / 2));
  });
  expect(off).toBeLessThan(20); // tolerates the difference in arrow slot and scrollbar width
});

for (const width of [400, 800]) {
  test(`notice line, find bar and about dialog fit on screen (${width}px)`, async () => {
    const page = await openViewer(width, 700);
    // Insert a long notice directly (the notice line is fixed below the toolbar, the find bar below it).
    await page.evaluate(() => {
      const bar = document.getElementById('notice-bar')!;
      const row = document.createElement('div');
      row.className = 'notice';
      row.textContent = '알림 '.repeat(80);
      bar.append(row);
      bar.hidden = false;
    });
    await page.waitForTimeout(200);
    const { w, h } = await viewportSize(page);
    const nb = (await page.locator('#notice-bar').boundingBox()) as Box;
    expect(nb.x).toBeGreaterThanOrEqual(-0.5);
    expect(nb.x + nb.width).toBeLessThanOrEqual(w + 0.5);

    await page.locator('#page-container').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+f');
    const find = page.locator('.pe-find');
    await expect(find).toBeVisible();
    const fb = (await find.boundingBox()) as Box;
    expect(fb.x, '검색창 left').toBeGreaterThanOrEqual(-0.5);
    expect(fb.x + fb.width, '검색창 right').toBeLessThanOrEqual(w + 0.5);
    expect(fb.y, '검색창은 알림 줄 아래').toBeGreaterThanOrEqual(nb.y + nb.height - 0.5);
    await page.keyboard.press('Escape');

    await page.click('#about');
    const dialog = page.locator('#app-dialog');
    await expect(dialog).toBeVisible();
    const db = (await dialog.boundingBox()) as Box;
    expect(db.x, '대화상자 left').toBeGreaterThanOrEqual(-0.5);
    expect(db.x + db.width, '대화상자 right').toBeLessThanOrEqual(w + 0.5);
    expect(db.y, '대화상자 top').toBeGreaterThanOrEqual(-0.5);
    expect(db.y + db.height, '대화상자 bottom').toBeLessThanOrEqual(h + 0.5);
  });
}

test('the context badge is not on screen and remains as body[data-context]', async () => {
  const page = await openViewer(1000, 700, false);
  await expect(page.locator('#context-badge')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-context', 'url-param');
});

test('find result scrolling moves the document area (#page-container) and does not scroll the window', async () => {
  const page = await openViewer(900, 420, false);
  await expect(page.locator('#pe-text-layer .pe-line').first()).toBeAttached();
  // Pick a word in a lower line of the page that appears only once in the whole document (so the current result lands there).
  const word = await page.evaluate(() => {
    const lines = [...document.querySelectorAll<HTMLElement>('#pe-text-layer .pe-line')];
    const all = lines.map((l) => l.textContent ?? '').join('\n');
    const count = (w: string) => all.split(w).length - 1;
    const byTop = lines
      .map((l) => ({
        text: l.textContent ?? '',
        top: l.querySelector('span')?.getBoundingClientRect().top ?? 0,
      }))
      .sort((a, b) => b.top - a.top);
    for (const l of byTop) {
      for (const w of l.text.split(/\s+/)) {
        if (/^[A-Za-z]{5,}$/.test(w) && count(w) === 1) return { w, top: l.top };
      }
    }
    return null;
  });
  expect(word, '아래쪽 고유 단어').not.toBeNull();
  const container = page.locator('#page-container');
  const viewportH = await page.evaluate(() => document.documentElement.clientHeight);
  expect(word!.top).toBeGreaterThan(viewportH);
  await page.keyboard.press('Control+F');
  await page.locator('#pe-find-input').fill(word!.w);
  const current = page.locator('#pe-highlights .pe-hl[data-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toBeInViewport();
  expect(await container.evaluate((c) => c.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  await expect(page.locator('#toolbar')).toBeInViewport();
});
