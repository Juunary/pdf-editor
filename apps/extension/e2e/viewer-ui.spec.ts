/**
 * M1 viewer-ui e2e (docs/m1-viewer-ui.md).
 *
 * 1) Harness tests: serve only the viewer-ui build output with a synthetic PageModel and a fake host, and check DOM behavior (text layer placement,
 *    drag selection and copy, Ctrl+F, highlight, debug overlay, feature disabling) in a real Chromium.
 * 2) Integration scenarios (enabled after the 2026-10-19 m1 integration): in the built extension, check with the real core extraction and search and pdf-ops matching
 *    selection and copy (plain viewer, MIME handler top-level, embedded), Ctrl+F and the debug overlay (docs/m1-integration.md).
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PageLayout as DocumentPageLayout,
  PageLinkage,
  PageModel,
  SourceMap,
} from '@pdf-editor/shared-types';
import { reconstructPage } from '../../../packages/layout-recon/src/reconstruct.js';
import {
  makeLinkage,
  makePageModel,
  makeSourceMap,
  makeTextOp,
} from '../../../packages/viewer-ui/test/fixtures.js';
import { E2E_LOCALE } from './locale.js';

// ── Common ──────────────────────────────────────────────────────────────

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const UI_ROOT = fileURLToPath(new URL('../../../packages/viewer-ui/', import.meta.url));

/** Tolerance (CSS px) when reading pointer coordinates. Margin for subpixel rounding and transform rounding. */
const PX = 0.75;

// ══ 1. Harness ═════════════════════════════════════════════════════

interface HarnessConfig {
  pages: PageModel[];
  maps?: SourceMap[];
  linkages?: PageLinkage[];
  layouts?: DocumentPageLayout[];
  /** Error message the host call throws. */
  failures?: { extract?: string; search?: string; link?: string; layout?: string };
  /** Fixed pt → CSS px scale. */
  cssScale: number;
}

const requireFromUi = createRequire(join(UI_ROOT, 'package.json'));
const PREACT_DIR = dirname(requireFromUi.resolve('preact/package.json'));
const VENDOR_FILES: Record<string, string> = {
  '/vendor/preact.js': join(PREACT_DIR, 'dist/preact.module.js'),
  '/vendor/hooks.js': join(PREACT_DIR, 'hooks/dist/hooks.module.js'),
  '/vendor/jsx-runtime.js': join(PREACT_DIR, 'jsx-runtime/dist/jsxRuntime.module.js'),
};

const HARNESS_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({
  imports: {
    preact: '/vendor/preact.js',
    'preact/hooks': '/vendor/hooks.js',
    'preact/jsx-runtime': '/vendor/jsx-runtime.js',
  },
})}</script>
<link rel="stylesheet" href="/ui/style.css">
<style>
  body { margin: 0; background: #525659; font: 13px system-ui, sans-serif; }
  #toolbar { position: sticky; top: 0; z-index: 20; display: flex; gap: 8px; align-items: center;
    padding: 6px 10px; background: #323639; color: #eee; }
  #page-container { display: flex; justify-content: center; padding: 16px; }
</style></head>
<body>
<header id="toolbar"><div id="viewer-controls"></div></header>
<main id="page-container"></main>
<script type="module" src="/harness.js"></script>
</body></html>`;

/** Harness script run in the page (plain JS). Mounts viewer-ui with the fake host. */
const HARNESS_JS = `
import { ViewerController, mountViewer } from '/ui/index.js';
const cfg = window.__cfg;
const log = [];
window.__log = log;

function search(req) {
  const n = cfg.pages.length;
  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const hits = [];
  for (let k = 0; k < n; k++) {
    const pageIndex = ((req.startPage ?? 0) + k) % n;
    const model = cfg.pages[pageIndex];
    for (const line of model.lines) {
      const text = line.chars.map((i) => model.chars[i].text).join('');
      const hay = req.caseSensitive ? text : text.toLowerCase();
      for (let at = needle ? hay.indexOf(needle) : -1; at >= 0; at = hay.indexOf(needle, at + 1)) {
        const a = model.chars[line.chars[at]].quad;
        const b = model.chars[line.chars[at + needle.length - 1]].quad;
        hits.push({ pageIndex, quads: [[a[0], a[1], b[2], b[3], a[4], a[5], b[6], b[7]]] });
      }
    }
  }
  return { query: req.query, hits, truncated: false, pagesSearched: n, searchMs: 1 };
}

const size = (m) => ({ width: m.bounds[2] - m.bounds[0], height: m.bounds[3] - m.bounds[1] });
const host = {
  getPageInfo: async (i) => {
    const m = cfg.pages[i];
    return { pageIndex: i, bounds: m.bounds, size: size(m), rotation: 0 };
  },
  renderPage: async (req) => {
    const s = size(cfg.pages[req.pageIndex]);
    const width = Math.ceil(s.width * req.scale);
    const height = Math.ceil(s.height * req.scale);
    return { pageIndex: req.pageIndex, width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255), renderMs: 1 };
  },
  extractPage: async (req) => {
    if (cfg.failures?.extract) throw new Error(cfg.failures.extract);
    return cfg.pages[req.pageIndex];
  },
  getSourceMap: async (i) => {
    if (cfg.failures?.link) throw new Error(cfg.failures.link);
    return cfg.maps[i];
  },
  linkPage: async (i) => {
    if (cfg.failures?.link) throw new Error(cfg.failures.link);
    return cfg.linkages[i];
  },
  searchText: async (req) => {
    if (cfg.failures?.search) throw new Error(cfg.failures.search);
    return search(req);
  },
  getPageLayout: async (i) => {
    if (cfg.failures?.layout) throw new Error(cfg.failures.layout);
    return cfg.layouts[i];
  },
  log: (event, data) => log.push({ event, data }),
};

const controller = new ViewerController({
  host,
  pageCount: cfg.pages.length,
  getEnvironment: () => ({ devicePixelRatio: window.devicePixelRatio || 1, availableWidth: document.documentElement.clientWidth }),
  cssScaleFor: () => cfg.cssScale,
  onPagePainted: (e) => { window.__painted = e; document.body.dataset.painted = String(e.pageIndex); },
});
window.__controller = controller;
mountViewer(
  { controls: document.getElementById('viewer-controls'), pages: document.getElementById('page-container') },
  controller,
);
await controller.start();
document.body.dataset.ready = '1';
`;

let harnessServer: Server;
let harnessBase = '';

function startHarnessServer(): Promise<void> {
  harnessServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (file: string, type: string) => {
      try {
        res.writeHead(200, { 'content-type': type }).end(readFileSync(file));
      } catch {
        res.writeHead(404).end();
      }
    };
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HARNESS_HTML);
    } else if (path === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(HARNESS_JS);
    } else if (path in VENDOR_FILES) {
      send(VENDOR_FILES[path]!, 'text/javascript');
    } else if (path === '/ui/style.css') {
      send(join(UI_ROOT, 'src/style.css'), 'text/css');
    } else if (
      path.startsWith('/ui/') &&
      /^\/ui\/[\w./-]+\.js$/.test(path) &&
      !path.includes('..')
    ) {
      send(join(UI_ROOT, 'dist', path.slice('/ui/'.length)), 'text/javascript');
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    harnessServer.listen(0, '127.0.0.1', () => {
      const addr = harnessServer.address();
      harnessBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    }),
  );
}

type Win = typeof window & { __copied?: string | null; __log?: { event: string; data: unknown }[] };

async function openHarness(page: Page, cfg: HarnessConfig): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((c) => {
    (window as unknown as { __cfg: unknown }).__cfg = c;
  }, cfg);
  await page.goto(`${harnessBase}/`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.evaluate(() => {
    // The window listener runs after the document listener (the text layer's copy handling), so it reads the final copied text.
    window.addEventListener('copy', (e) => {
      (window as Win).__copied = e.clipboardData?.getData('text/plain') ?? null;
    });
  });
  expect(errors, '하니스 페이지 오류').toEqual([]);
}

/** Synthetic page. Glyphs 10×14pt, line spacing 20pt, left 20pt, top 20pt. */
const LINES = [
  { text: 'Hello World', block: 1 },
  { text: 'Second line here', block: 1 },
  { text: '한글 문단 하나', block: 2 },
];
const PAGE_0 = makePageModel(LINES);
const PAGE_1: PageModel = {
  ...makePageModel([
    { text: 'Another page with Hello', block: 1 },
    { text: 'hello again', block: 1 },
  ]),
  pageIndex: 1,
};
const FULL_TEXT = 'Hello World\nSecond line here\n\n한글 문단 하나';

function baseConfig(extra: Partial<HarnessConfig> = {}): HarnessConfig {
  return { pages: [PAGE_0, PAGE_1], cssScale: 1.5, ...extra };
}

interface Geo {
  x: number;
  y: number;
  scale: number;
}

async function geo(page: Page): Promise<Geo> {
  const surface = page.locator('#pe-page');
  const box = await surface.boundingBox();
  if (!box) throw new Error('#pe-page 없음');
  return { x: box.x, y: box.y, scale: Number(await surface.getAttribute('data-css-scale')) };
}

/** Glyph position (pt) on the synthetic page → screen coordinates. fx and fy are ratios inside the glyph box. */
function charAt(g: Geo, line: number, col: number, fx = 0.5, fy = 0.5, x0 = 20) {
  return {
    x: g.x + (x0 + col * 10 + fx * 10) * g.scale,
    y: g.y + (20 + line * 20 + fy * 14) * g.scale,
  };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function copied(page: Page): Promise<string | null> {
  await page.evaluate(() => {
    (window as Win).__copied = null;
  });
  await page.keyboard.press('Control+C');
  await expect
    .poll(() => page.evaluate(() => (window as Win).__copied ?? null), { timeout: 3000 })
    .not.toBeNull();
  return page.evaluate(() => (window as Win).__copied ?? null);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('boundingBox 없음');
  return box;
}

interface DebugControllerLike {
  toggleDebug(): void;
  getState(): { debugEnabled: boolean; disabled: Record<string, string | null> };
}

/**
 * Turning the linkage debug overlay on and off. The toolbar button was removed (user request 2026-10-22): the harness calls the controller directly via `window.__controller`,
 * and the extension viewer via the `?e2e` seam (`window.__pe.controller`).
 */
async function toggleDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __controller?: DebugControllerLike;
      __pe?: { controller: DebugControllerLike | null };
    };
    (w.__controller ?? w.__pe?.controller)!.toggleDebug();
  });
}

async function debugState(page: Page): Promise<{ enabled: boolean; disabled: string | null }> {
  return page.evaluate(() => {
    const s = (window as unknown as { __controller: DebugControllerLike }).__controller.getState();
    return { enabled: s.debugEnabled, disabled: s.disabled.debug ?? null };
  });
}

function expectBox(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  label: string,
) {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual[key] - expected[key]),
      `${label} ${key}: ${actual[key]} vs ${expected[key]}`,
    ).toBeLessThanOrEqual(PX);
  }
}

test.describe('viewer-ui harness (synthetic PageModel, fake host)', () => {
  test.beforeAll(startHarnessServer);
  test.afterAll(() => harnessServer.close());

  test('text layer: glyph spans sit at quad × scale position and size, and DOM order is reading order', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    expect(g.scale).toBe(1.5);
    const spans = page.locator('#pe-text-layer span[data-i]');
    expect(await spans.count()).toBe(PAGE_0.chars.length);
    // Glyphs in DOM order = glyphs in reading order
    const domText = await spans.evaluateAll((els) => els.map((e) => e.textContent).join(''));
    expect(domText).toBe(LINES.map((l) => l.text).join(''));
    // Every glyph box matches the quad position and size (width is fitted with scaleX)
    for (const [idx, char] of PAGE_0.chars.entries()) {
      const [x0, y0, x1, , , y2] = char.quad;
      expectBox(
        await boxOf(spans.nth(idx)),
        { x: g.x + x0 * 1.5, y: g.y + y0 * 1.5, width: (x1 - x0) * 1.5, height: (y2 - y0) * 1.5 },
        `글자 #${idx} "${char.text}"`,
      );
    }
    // Glyphs are transparent
    const color = await spans.first().evaluate((e) => getComputedStyle(e).color);
    expect(color).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test.describe('devicePixelRatio 2', () => {
    test.use({ deviceScaleFactor: 2 });

    test('canvas bitmap is dpr times, overlays stay in CSS px', async ({ page }) => {
      await openHarness(page, baseConfig());
      const canvas = page.locator('#page-canvas');
      const attrs = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
      // Page 600×800pt × 1.5 (CSS scale) × 2 (dpr)
      expect(attrs).toEqual({ w: 1800, h: 2400 });
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
      const box = await boxOf(page.locator('#pe-page'));
      expect([box.width, box.height]).toEqual([900, 1200]);
      const first = await boxOf(page.locator('#pe-text-layer span[data-i="0"]'));
      expectBox(first, { x: box.x + 30, y: box.y + 30, width: 15, height: 21 }, 'dpr 2 첫 글자');
    });
  });

  test('drag selection → Ctrl+C: text spanning lines is copied in reading order', async ({
    page,
  }, testInfo) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    // Left half of 'W' (index 6) on line 1 → right half of 'd' (index 5) on line 2
    await drag(page, charAt(g, 0, 6, 0.2), charAt(g, 1, 5, 0.8));
    expect(await copied(page)).toBe('World\nSecond');
    // Highlight: one box per line, the quad × scale of the selected glyph range (no stripe overlapping the line-break marker)
    const rects = page.locator('#pe-selection .pe-sel');
    await expect(rects).toHaveCount(2);
    expectBox(
      await boxOf(rects.nth(0)),
      { x: g.x + 80 * 1.5, y: g.y + 20 * 1.5, width: 50 * 1.5, height: 14 * 1.5 },
      '선택 1줄',
    );
    expectBox(
      await boxOf(rects.nth(1)),
      { x: g.x + 20 * 1.5, y: g.y + 40 * 1.5, width: 60 * 1.5, height: 14 * 1.5 },
      '선택 2줄',
    );
    await page.screenshot({ path: testInfo.outputPath('selection.png') });
    // Clearing the selection also removes the highlight
    await page.mouse.click(g.x + 5, g.y + 5);
    await expect(rects).toHaveCount(0);
  });

  test('crossing a block boundary inserts an empty line', async ({ page }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    await drag(page, charAt(g, 1, 7, 0.2), charAt(g, 2, 1, 0.8)); // 'line here' … '한글'
    expect(await copied(page)).toBe('line here\n\n한글');
  });

  test('dragging past the line end, between lines or below the text does not make the selection jump', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    const start = charAt(g, 0, 6, 0.2);
    // Empty area to the right of line 2 (outside the line end)
    await drag(page, start, { x: g.x + 580 * g.scale, y: charAt(g, 1, 0).y });
    expect(await copied(page)).toBe('World\nSecond line here');
    // Gap between line 1 (20–34pt) and line 2 (40–54pt), closer to line 1: y = 35pt, the right half of the last glyph of line 1
    await drag(page, start, { x: charAt(g, 0, 10, 0.9).x, y: g.y + 35 * g.scale });
    expect(await copied(page)).toBe('World');
    // Below the entire text
    await drag(page, start, { x: g.x + 300 * g.scale, y: g.y + 700 * g.scale });
    expect(await copied(page)).toBe('World\nSecond line here\n\n한글 문단 하나');
  });

  test('dragging backwards (upwards) selects the same range', async ({ page }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    await drag(page, charAt(g, 1, 3, 0.2), charAt(g, 0, 2, 0.2));
    expect(await copied(page)).toBe('llo World\nSec');
  });

  test('double-click = word, triple-click = line, Ctrl+A = all, click = clear selection', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    const inWorld = charAt(g, 0, 8);
    await page.mouse.dblclick(inWorld.x, inWorld.y);
    expect(await copied(page)).toBe('World');
    const inLine2 = charAt(g, 1, 8);
    await page.mouse.click(inLine2.x, inLine2.y, { clickCount: 3 });
    expect(await copied(page)).toBe('Second line here');
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe(FULL_TEXT);
    // A single click clears the selection
    await page.mouse.click(inWorld.x, inWorld.y);
    expect(await page.evaluate(() => document.getSelection()?.isCollapsed ?? true)).toBe(true);
  });

  test('synthetic space (spaceAfter): copy contains the space, and DOM line text and word boundaries are correct', async ({
    page,
  }) => {
    // A line like a document whose words are split by TJ gaps: no space glyph, only the structured text's synthetic space
    const latex = makePageModel([
      { text: 'foobarbaz', block: 1, spaceAfter: [2, 5] },
      { text: 'tail', block: 1 },
    ]);
    await openHarness(page, { pages: [latex], cssScale: 1.5 });
    const g = await geo(page);

    // DOM: the synthetic space is a separate element distinguished from the glyph spans, and the line text contains the space.
    await expect(page.locator('#pe-text-layer span[data-i]')).toHaveCount(13);
    await expect(page.locator('#pe-text-layer span[data-space]')).toHaveCount(2);
    expect(
      await page
        .locator('#pe-text-layer .pe-line')
        .evaluateAll((lines) => lines.map((l) => l.textContent)),
    ).toEqual(['foo bar baz', 'tail']);

    // Select all: "foo bar baz\ntail" without a trailing space on the line
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe('foo bar baz\ntail');
    // Drag: only spaces whose neighboring glyphs are both in the selection are included
    await drag(page, charAt(g, 0, 1, 0.2), charAt(g, 0, 7, 0.8));
    expect(await copied(page)).toBe('oo bar ba');
    await drag(page, charAt(g, 0, 3, 0.2), charAt(g, 0, 5, 0.8));
    expect(await copied(page)).toBe('bar');
    // Double-click: the synthetic space is a word boundary
    const inBar = charAt(g, 0, 4);
    await page.mouse.dblclick(inBar.x, inBar.y);
    expect(await copied(page)).toBe('bar');
    // The highlight continues including the space position (first line 9 characters = 90pt)
    await page.keyboard.press('Control+A');
    const rects = page.locator('#pe-selection .pe-sel');
    await expect(rects).toHaveCount(2);
    expectBox(
      await boxOf(rects.nth(0)),
      { x: g.x + 20 * 1.5, y: g.y + 20 * 1.5, width: 90 * 1.5, height: 14 * 1.5 },
      '합성 공백 줄 선택',
    );
  });

  test('copy outside the selection area (toolbar) is not intercepted', async ({ page }) => {
    await openHarness(page, baseConfig());
    await page.locator('#pe-page-input').fill('1');
    await page.locator('#pe-page-input').selectText();
    await page.evaluate(() => {
      (window as Win).__copied = null;
    });
    await page.keyboard.press('Control+C');
    // Copying in an input field gives nothing to read because we do not fill text/plain.
    expect(await page.evaluate(() => (window as Win).__copied ?? '')).toBe('');
  });

  test('copy text also lands in the real clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openHarness(page, baseConfig());
    const g = await geo(page);
    await drag(page, charAt(g, 0, 0, 0.2), charAt(g, 0, 4, 0.8));
    await page.keyboard.press('Control+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3000 })
      .toBe('Hello');
  });

  test('page navigation: previous, next, number input; invalid input is reverted', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    const input = page.locator('#pe-page-input');
    await expect(input).toHaveValue('1');
    await expect(page.locator('#pe-page-count')).toHaveText('/ 2');
    await expect(page.locator('#pe-prev')).toBeDisabled();
    await page.locator('#pe-next').click();
    await expect(page.locator('body')).toHaveAttribute('data-painted', '1');
    await expect(input).toHaveValue('2');
    await expect(page.locator('#pe-next')).toBeDisabled();
    await expect(page.locator('#pe-text-layer span[data-i="0"]')).toHaveText('A'); // page 2 text
    await input.fill('1');
    await input.press('Enter');
    await expect(page.locator('body')).toHaveAttribute('data-painted', '0');
    await expect(input).toHaveValue('1');
    await input.fill('9');
    await input.press('Enter');
    await expect(input).toHaveValue('1');
    await input.fill('abc');
    await input.blur();
    await expect(input).toHaveValue('1');
  });

  test('Ctrl+F: find bar, result count, previous/next, highlight position = quad × scale, page navigation', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    await page.keyboard.press('Control+F');
    const find = page.locator('#pe-find-input');
    await expect(find).toBeFocused();
    await find.fill('Hello');
    const count = page.locator('#pe-find-count');
    await expect(count).toHaveText('1 / 3');

    // Current page (0) has 1 result, and the position matches quad × scale
    const g = await geo(page);
    const highlights = page.locator('#pe-highlights .pe-hl');
    await expect(highlights).toHaveCount(1);
    expect(await highlights.first().getAttribute('data-quad')).toBe('20,20,70,20,20,34,70,34');
    expectBox(
      await boxOf(highlights.first()),
      { x: g.x + 20 * 1.5, y: g.y + 20 * 1.5, width: 50 * 1.5, height: 14 * 1.5 },
      '하이라이트',
    );
    await expect(highlights.first()).toHaveAttribute('data-current', 'true');

    // Enter: the next result is on page 2. The page navigates and the 2 results of page 2 are painted.
    await find.press('Enter');
    await expect(count).toHaveText('2 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');
    await expect(highlights).toHaveCount(2);
    await expect(page.locator('#pe-highlights .pe-hl[data-current="true"]')).toHaveCount(1);
    await find.press('Enter');
    await expect(count).toHaveText('3 / 3');
    // Wrap-around: 3 → 1 (page 1)
    await find.press('Enter');
    await expect(count).toHaveText('1 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('1');
    // Shift+Enter: 1 → 3 (page 2)
    await find.press('Shift+Enter');
    await expect(count).toHaveText('3 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');

    // Buttons
    await page.locator('#pe-find-prev').click();
    await expect(count).toHaveText('2 / 3');
    await page.locator('#pe-find-next').click();
    await expect(count).toHaveText('3 / 3');

    // Esc: close, remove highlight
    await find.press('Escape');
    await expect(page.locator('#pe-find')).toHaveCount(0);
    await expect(page.locator('#pe-highlights')).toHaveCount(0);
  });

  test('Ctrl+F: searches from the current page (starting on page 2 gives page 2 results first)', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    await page.locator('#pe-next').click();
    await expect(page.locator('body')).toHaveAttribute('data-painted', '1');
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('hello');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');
    // Line 1 of page 2 'Another page with Hello' has 'Hello' (glyphs 18–22)
    await expect(page.locator('#pe-highlights .pe-hl[data-current="true"]')).toHaveAttribute(
      'data-quad',
      '200,20,250,20,200,34,250,34',
    );
  });

  test('Ctrl+F: case sensitivity, no results, reopening the find bar', async ({ page }) => {
    await openHarness(page, baseConfig());
    await page.keyboard.press('Control+F');
    const find = page.locator('#pe-find-input');
    await find.fill('Hello');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 3');
    await page.locator('#pe-find-case').check();
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 2');
    await find.fill('zzz');
    await expect(page.locator('#pe-find-count')).toHaveText('결과 없음');
    await expect(page.locator('#pe-highlights')).toHaveCount(0);
    await expect(page.locator('#pe-find-next')).toBeDisabled();
    // Pressing Ctrl+F again focuses the input and selects all
    await page.locator('#pe-page-input').focus();
    await page.keyboard.press('Control+F');
    await expect(find).toBeFocused();
    expect(await find.evaluate((e: HTMLInputElement) => e.selectionEnd! - e.selectionStart!)).toBe(
      3,
    );
  });

  test('Ctrl+F: if the current result is off screen (below the scroll), scroll it into view', async ({
    page,
  }) => {
    const tall = makePageModel([
      { text: 'Top line', y: 20 },
      { text: 'Bottom target', y: 740 },
    ]);
    await openHarness(page, { pages: [tall], cssScale: 1.5 });
    await page.keyboard.press('Control+F');
    await expect(page.locator('#pe-page-input')).toHaveValue('1');
    await page.locator('#pe-find-input').fill('target');
    const current = page.locator('#pe-highlights .pe-hl[data-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    // Returning to the first line result scrolls up
    await page.locator('#pe-find-input').fill('top');
    await expect(current).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(100);
  });

  test('debug overlay: color coding by match, summary, SourceOp of the glyph under the mouse', async ({
    page,
  }, testInfo) => {
    // Glyph matching: line 1 (11 chars) → op 0, first 3 glyphs of line 2 → failure (-1), remaining 13 chars of line 2 → op 1 (edit restricted), line 3 (8 chars) → op 2
    const n = PAGE_0.chars.length;
    const charOp = PAGE_0.chars.map((_, i) => (i < 11 ? 0 : i < 14 ? -1 : i < 11 + 16 ? 1 : 2));
    expect(charOp.length).toBe(n);
    const ops = [
      makeTextOp(0),
      makeTextOp(1, { limits: ['spans-stream-boundary'] }),
      makeTextOp(2, { stream: { objectNumber: 21, contentsIndex: null } }),
    ];
    await openHarness(
      page,
      baseConfig({
        maps: [makeSourceMap(PAGE_0, ops), makeSourceMap(PAGE_1, ops)],
        linkages: [
          makeLinkage(PAGE_0, charOp),
          makeLinkage(
            PAGE_1,
            PAGE_1.chars.map(() => 0),
          ),
        ],
      }),
    );
    await expect(page.locator('#pe-debug-canvas')).toHaveCount(0);
    // The toolbar has no debug button (user request 2026-10-22).
    await expect(page.locator('#pe-debug-toggle')).toHaveCount(0);
    await toggleDebug(page);
    const canvas = page.locator('#pe-debug-canvas');
    await expect(canvas).toHaveAttribute('data-matched', String(11 + 8));
    await expect(canvas).toHaveAttribute('data-limited', String(13));
    await expect(canvas).toHaveAttribute('data-unmatched', '3');
    await expect(page.locator('#pe-debug-hud')).toContainText('글자 ');

    // Color check: center pixels of matched (green-ish) and failed (red-ish) glyphs
    const pixel = (cssX: number, cssY: number) =>
      canvas.evaluate(
        (c: HTMLCanvasElement, [x, y]: [number, number]) => {
          const k = c.width / c.getBoundingClientRect().width; // bitmap-to-CSS ratio
          return Array.from(
            c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data,
          );
        },
        [cssX, cssY] as [number, number],
      );
    const matchedPx = await pixel((20 + 5) * 1.5, (20 + 7) * 1.5); // first glyph of line 1 (matched)
    const failedPx = await pixel((20 + 5) * 1.5, (40 + 7) * 1.5); // first glyph of line 2 (failed)
    expect(matchedPx[1]!).toBeGreaterThan(matchedPx[0]!);
    expect(failedPx[0]!).toBeGreaterThan(failedPx[1]!);

    // Hover: matched glyph → op info
    const g = await geo(page);
    const hoverMatched = charAt(g, 0, 2);
    await page.mouse.move(hoverMatched.x, hoverMatched.y);
    const tip = page.locator('#pe-debug-tip');
    await expect(tip).toContainText('연산 #0 Tj (text-show)');
    await expect(tip).toContainText('Contents[0] obj 8');
    await expect(tip).toContainText('범위 100–110');
    await expect(tip).toContainText('제한: 없음');
    // Edit-restricted glyph
    const hoverLimited = charAt(g, 1, 8);
    await page.mouse.move(hoverLimited.x, hoverLimited.y);
    await expect(tip).toContainText('연산 #1');
    await expect(tip).toContainText('제한: spans-stream-boundary');
    // Match-failed glyph
    const hoverFailed = charAt(g, 1, 1);
    await page.mouse.move(hoverFailed.x, hoverFailed.y);
    await expect(tip).toContainText('원본 연결: 실패');
    // Moving off the glyph makes the tooltip disappear
    await page.mouse.move(g.x + 5, g.y + 5);
    await expect(tip).toHaveCount(0);
    // Text selection works even during debugging
    await page.mouse.move(hoverLimited.x, hoverLimited.y);
    await page.screenshot({ path: testInfo.outputPath('debug-overlay.png') });
    await drag(page, charAt(g, 0, 0, 0.2), charAt(g, 0, 4, 0.8));
    expect(await copied(page)).toBe('Hello');
    // Turning it off makes the overlay disappear
    await toggleDebug(page);
    await expect(canvas).toHaveCount(0);
  });

  test('dense page (11,000 chars): text layer preparation, select-all copy and drag selection finish within the allowed time', async ({
    page,
  }, testInfo) => {
    // 100 chars of 5×6pt glyphs × 110 lines. More glyphs than a dense page of a real document (small type).
    const text = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const dense = makePageModel(
      Array.from({ length: 110 }, () => ({ text, block: 1 })),
      { charWidth: 5, charHeight: 6, lineGap: 1 },
    );
    expect(dense.chars.length).toBe(11_000);
    const t0 = Date.now();
    await openHarness(page, { pages: [dense], cssScale: 1.5 });
    await page.locator('#pe-text-layer span[data-i="10999"]').waitFor();
    const readyMs = Date.now() - t0;

    const t1 = Date.now();
    await page.keyboard.press('Control+A');
    const all = await copied(page);
    const selectAllMs = Date.now() - t1;
    expect(all?.split('\n')).toHaveLength(110);

    const g = await geo(page);
    const t2 = Date.now();
    await drag(
      page,
      { x: g.x + 20 * g.scale, y: g.y + 20 * g.scale },
      { x: g.x + 400 * g.scale, y: g.y + 700 * g.scale },
    );
    const dragged = await copied(page);
    const dragMs = Date.now() - t2;
    expect((dragged ?? '').length).toBeGreaterThan(5000);

    const timings = { chars: dense.chars.length, readyMs, selectAllMs, dragMs };
    console.log(`[perf] ${JSON.stringify(timings)}`);
    await testInfo.attach('dense-page-timings', {
      body: JSON.stringify(timings),
      contentType: 'application/json',
    });
    expect(readyMs).toBeLessThan(8000);
    expect(selectAllMs).toBeLessThan(3000);
    expect(dragMs).toBeLessThan(5000);
  });

  test('M1 not implemented: only text, search and debug are disabled; rendering and page navigation are kept', async ({
    page,
  }) => {
    await openHarness(
      page,
      baseConfig({
        failures: {
          extract: 'M1 미구현: core extractPage',
          search: 'M1 미구현: core searchText',
        },
      }),
    );
    await expect(page.locator('#page-canvas')).toBeVisible();
    await expect(page.locator('#pe-text-layer')).toHaveCount(0);
    await expect(page.locator('#pe-notice')).toContainText('텍스트 선택');
    // Debug does not turn on without a PageModel.
    await toggleDebug(page);
    expect((await debugState(page)).enabled).toBe(false);
    const events = () => page.evaluate(() => ((window as Win).__log ?? []).map((l) => l.event));
    expect((await events()).filter((e) => e === 'extract-unavailable')).toHaveLength(1);

    // Page navigation keeps working, and the same log is not repeated.
    await page.locator('#pe-next').click();
    await expect(page.locator('body')).toHaveAttribute('data-painted', '1');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');
    expect((await events()).filter((e) => e === 'extract-unavailable')).toHaveLength(1);

    // The first Ctrl+F opens the find bar but the search ends as "unavailable",
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('a');
    await expect(page.locator('#pe-find-count')).toContainText('검색을 사용할 수 없습니다');
    expect(await events()).toContain('search-unavailable');
    await page.locator('#pe-find-input').press('Escape');
    // Later Ctrl+F is not intercepted (left to the browser's default find).
    await expect(page.locator('#pe-find')).toHaveCount(0);
    await expect(page.locator('#pe-find-toggle')).toBeDisabled();
    await page.evaluate(() => {
      window.addEventListener('keydown', (e) => {
        (window as Win & { __key?: { prevented: boolean } }).__key = {
          prevented: e.defaultPrevented,
        };
      });
    });
    await page.keyboard.press('Control+F');
    await expect(page.locator('#pe-find')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as Win & { __key?: { prevented: boolean } }).__key),
    ).toEqual({ prevented: false });
  });

  test('when only linkPage is not implemented, only debug is disabled and text selection is kept', async ({
    page,
  }) => {
    await openHarness(page, baseConfig({ failures: { link: 'M1 미구현: pdf-ops linkPage' } }));
    await expect(page.locator('#pe-text-layer')).toHaveCount(1);
    await toggleDebug(page);
    await expect(page.locator('#pe-notice')).toContainText('연결 디버그');
    await expect.poll(async () => (await debugState(page)).disabled).not.toBeNull();
    expect((await debugState(page)).enabled).toBe(false);
    await expect(page.locator('#pe-debug-canvas')).toHaveCount(0);
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe(FULL_TEXT);
  });

  test('layout overlay: paragraph boxes, reading-order numbers, page navigation, text selection during the overlay', async ({
    page,
  }, testInfo) => {
    const layouts = [reconstructPage(PAGE_0), reconstructPage(PAGE_1)];
    await openHarness(page, baseConfig({ layouts }));
    await expect(page.locator('#pe-layout-canvas')).toHaveCount(0);
    await page.locator('#pe-overlay-toggle').click();
    const canvas = page.locator('#pe-layout-canvas');
    await expect(canvas).toHaveAttribute('data-paragraphs', String(layouts[0]!.paragraphs.length));
    await expect(canvas).toHaveAttribute('data-order', String(layouts[0]!.readingOrder.length));
    // Pixel just inside the left edge of the first paragraph box.
    const first = layouts[0]!.paragraphs[0]!.bbox;
    const px = await canvas.evaluate(
      (c: HTMLCanvasElement, [x, y]: [number, number]) => {
        const k = c.width / c.getBoundingClientRect().width;
        return Array.from(
          c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data,
        );
      },
      [(first[0] + 0.3) * 1.5, ((first[1] + first[3]) / 2) * 1.5] as [number, number],
    );
    // Regardless of role: a pixel inside the paragraph box has a translucent fill (not an empty canvas).
    expect(px[3]!).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('layout-overlay.png') });
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe(FULL_TEXT);
    await page.locator('#pe-next').click();
    await expect(canvas).toHaveAttribute('data-paragraphs', String(layouts[1]!.paragraphs.length));
    await page.locator('#pe-overlay-toggle').click();
    await expect(canvas).toHaveCount(0);
  });

  test('when getPageLayout is not implemented, only the layout is disabled and text selection is kept', async ({
    page,
  }) => {
    await openHarness(page, baseConfig({ failures: { layout: 'M2 미구현: core getPageLayout' } }));
    await page.locator('#pe-overlay-toggle').click();
    await expect(page.locator('#pe-notice')).toContainText('레이아웃');
    await expect(page.locator('#pe-overlay-toggle')).toBeDisabled();
    await expect(page.locator('#pe-layout-canvas')).toHaveCount(0);
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe(FULL_TEXT);
  });
});

// ══ 2. Extension integration ═════════════════════════════════════════════════════

function serveDiag(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const file = join(DIST, 'diag', basename(new URL(req.url ?? '/', 'http://x').pathname));
    try {
      const body = readFileSync(file);
      const type = file.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
      });
    }),
  );
}

interface ExtensionEnv {
  context: BrowserContext;
  extensionId: string;
  base: string;
}

async function withExtension<T>(fn: (env: ExtensionEnv) => Promise<T>): Promise<T> {
  const { server, base } = await serveDiag();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-ui-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: E2E_LOCALE,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    return await fn({ context, extensionId: new URL(sw.url()).host, base });
  } finally {
    await context.close();
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

interface DiagEntry {
  event: string;
  data: Record<string, unknown>;
}

async function diagOf(frame: Frame): Promise<DiagEntry[]> {
  return JSON.parse((await frame.textContent('#diag-log')) ?? '[]') as DiagEntry[];
}

async function openViewer(env: ExtensionEnv, file: string): Promise<Page> {
  const page = await env.context.newPage();
  await page.goto(`chrome-extension://${env.extensionId}/viewer.html?file=${env.base}/${file}`);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  return page;
}

/** Waits until the extraction result is settled: whether the text layer appeared, or whether it was disabled as "미구현" (not implemented). */
async function extractOutcome(page: Page): Promise<'text-layer' | 'unavailable'> {
  const found: { outcome: 'text-layer' | 'unavailable' | null } = { outcome: null };
  await expect
    .poll(
      async () => {
        if ((await page.locator('#pe-text-layer').count()) > 0) found.outcome = 'text-layer';
        else if ((await diagOf(page.mainFrame())).some((e) => e.event === 'extract-unavailable'))
          found.outcome = 'unavailable';
        return found.outcome;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return found.outcome ?? 'unavailable';
}

// ── Integration scenarios (enabled after the 2026-10-19 m1 integration) ──────────────────────────────
// Uses the real core extractPage, searchText and pdf-ops linkPage, getSourceMap.
// Reference documents: m0-sample.pdf (English, 1 page), m0-spike-saved.pdf (includes Korean).

/** Body text of m0-sample.pdf confirmed with pdftotext (differences in line breaks and whitespace are folded before comparison). */
const M0_SAMPLE_TEXT =
  'M0 Spike Sample: Paragraph Replacement This paragraph is the replacement target. It sits on a tinted panel ' +
  'with table rules crossing it. Redaction must remove only this text and keep the background, the rules, ' +
  'the border and the image. Line four ends the target paragraph. Adjacent paragraph: must stay unchanged ' +
  'after the edit. Second line of the adjacent paragraph. Footer text outside the panel.';

const fold = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

async function installCopyCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.addEventListener('copy', (e) => {
      (window as Win).__copied = e.clipboardData?.getData('text/plain') ?? null;
    });
  });
}

/** Text of the line spans (DOM reading order). */
async function textLines(page: Page): Promise<string[]> {
  return page
    .locator('#pe-text-layer .pe-line')
    .evaluateAll((lines) => lines.map((l) => l.textContent ?? ''));
}

test(`[integration] opening a second document by file selection cleans up the previous viewer before opening and draws the new document`, async () => {
  await withExtension(async (env) => {
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/viewer.html`);
    const input = page.locator('#open-file');
    const rendered = () =>
      expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
        timeout: 20_000,
      });
    await input.setInputFiles(join(DIST, 'diag/m0-sample.pdf'));
    await rendered();
    expect(await extractOutcome(page)).toBe('text-layer');

    await input.setInputFiles(join(DIST, 'diag/m0-spike-saved.pdf'));
    await expect
      .poll(async () => (await diagOf(page.mainFrame())).filter((e) => e.event === 'open').length)
      .toBe(2);
    await rendered();
    await expect(page).toHaveTitle('m0-spike-saved.pdf - PDF Editor');
    await expect
      .poll(
        async () =>
          ((await page.locator('#pe-text-layer').textContent()) ?? '').replace(/\s+/g, ''),
        { timeout: 15_000 },
      )
      .toContain('검색과복사');
    // Only one viewer DOM remains.
    await expect(page.locator('#pe-text-layer')).toHaveCount(1);
    const log = await diagOf(page.mainFrame());
    const events = log.map((e) => e.event);
    const secondOpen = events.lastIndexOf('open');
    expect(events.indexOf('viewer-unmount')).toBeGreaterThan(events.indexOf('open'));
    expect(events.indexOf('viewer-unmount')).toBeLessThan(secondOpen);
    expect(events.filter((e) => /error/.test(e))).toEqual([]);
  });
});

test(`[integration] select → copy: the Ctrl+A copy result matches the m0-sample.pdf extracted text`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await installCopyCapture(page);
    await page.keyboard.press('Control+A');
    expect(fold(await copied(page))).toBe(M0_SAMPLE_TEXT);
  });
});

test(`[integration] select → copy: dragging over the first two lines copies them in DOM line order`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await installCopyCapture(page);
    const lines = await textLines(page);
    expect(lines[0]).toContain('M0 Spike Sample');
    const firstLine = page.locator('#pe-text-layer .pe-line').nth(0).locator('span');
    const secondLine = page.locator('#pe-text-layer .pe-line').nth(1).locator('span');
    const from = await boxOf(firstLine.first());
    const to = await boxOf(secondLine.last());
    // The endpoint is outside the end of the second line (including the last glyph). The line separator follows the contract section 4 reading text rule:
    // "\n" for the same block, "\n\n" for a different block (in m0-sample the title and body are different blocks).
    const blocks = await page
      .locator('#pe-text-layer .pe-line')
      .evaluateAll((ls) => ls.slice(0, 2).map((l) => l.getAttribute('data-block')));
    const sep = blocks[0] === blocks[1] ? '\n' : '\n\n';
    await drag(
      page,
      { x: from.x + 1, y: from.y + from.height / 2 },
      { x: to.x + to.width + 8, y: to.y + to.height / 2 },
    );
    expect(await copied(page)).toBe(`${lines[0]}${sep}${lines[1]}`);
  });
});

test(`[integration] select → copy: the same copy result in the MIME handler top-level (shortcut right after opening) and embedded (after a click) contexts`, async () => {
  await withExtension(async (env) => {
    const top = await env.context.newPage();
    await top.goto(`${env.base}/m0-sample.pdf`);
    const prefix = `chrome-extension://${env.extensionId}/viewer.html`;
    await expect.poll(() => top.frames().filter((f) => f.url().startsWith(prefix)).length).toBe(1);
    const frame = top.frames().find((f) => f.url().startsWith(prefix))!;
    await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 20_000,
    });
    await frame.locator('#pe-text-layer').waitFor();
    await frame.evaluate(() => {
      window.addEventListener('copy', (e) => {
        (window as Win).__copied = e.clipboardData?.getData('text/plain') ?? null;
      });
    });
    // Top level: the viewer takes focus right after opening, so the shortcut goes to the viewer without a click.
    await top.keyboard.press('Control+A');
    await top.keyboard.press('Control+C');
    await expect
      .poll(async () => fold(await frame.evaluate(() => (window as Win).__copied ?? null)))
      .toBe(M0_SAMPLE_TEXT);

    // Embedded (embed, iframe, object): does not steal focus from the outer page, and clicking the text sends the shortcut to the viewer.
    // Check on a fresh page per element (focus movement between multiple viewers on one page is unstable in headless, so out of scope).
    // The frames() order is iframe (0), embed (1), object (2). For object, click focus in headless Chromium 156 fails
    // intermittently (3 of 8 runs measured on 2026-10-19), so it is excluded from automatic verification and left to manual Windows Chrome checks.
    for (const index of [0, 1]) {
      const host = await env.context.newPage();
      await host.goto(`${env.base}/embed-test.html`);
      await expect
        .poll(() => host.frames().filter((f) => f.url().startsWith(prefix)).length)
        .toBe(3);
      const f = host.frames().filter((x) => x.url().startsWith(prefix))[index]!;
      const tag = `embedded#${index}`;
      // Wait for render completion and text layer creation, then settle briefly (a click while the render is finishing can be missed).
      await expect(f.locator('#status')).toHaveAttribute('data-state', 'rendered', {
        timeout: 20_000,
      });
      await f.locator('#pe-text-layer').waitFor({ timeout: 20_000 });
      await host.waitForTimeout(300);
      expect(await f.evaluate(() => document.hasFocus()), `${tag}: 자동 포커스 없음`).toBe(false);
      await f.evaluate(() => {
        (window as Win).__copied = null;
        window.addEventListener('copy', (e) => {
          (window as Win).__copied = e.clipboardData?.getData('text/plain') ?? null;
        });
      });
      // The glyph span is transparent, so force. After confirming the click gave focus to that viewer, send the shortcut.
      await f.locator('#pe-text-layer span[data-i]').first().click({ force: true });
      await expect
        .poll(() => f.evaluate(() => document.hasFocus()), { message: `${tag}: 클릭 후 포커스` })
        .toBe(true);
      await host.keyboard.press('Control+A');
      await host.keyboard.press('Control+C');
      await expect
        .poll(async () => fold(await f.evaluate(() => (window as Win).__copied ?? null)), {
          message: tag,
        })
        .toBe(M0_SAMPLE_TEXT);
      await host.close();
    }
  });
});

test(`[integration] Ctrl+F: 5 hits for 'paragraph', highlights match glyph positions, Enter cycles`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('paragraph');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 5');
    const highlights = page.locator('#pe-highlights .pe-hl');
    await expect(highlights).toHaveCount(5);

    // Collecting the text-layer glyphs whose centers fall inside the highlight box should equal the search term.
    const spans = page.locator('#pe-text-layer span[data-i]');
    const spanBoxes = await spans.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { t: e.textContent ?? '', cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      }),
    );
    for (let i = 0; i < 5; i++) {
      const b = await boxOf(highlights.nth(i));
      const inside = spanBoxes
        .filter(
          (s) => s.cx >= b.x && s.cx <= b.x + b.width && s.cy >= b.y && s.cy <= b.y + b.height,
        )
        .map((s) => s.t)
        .join('');
      expect(inside.toLowerCase(), `하이라이트 #${i}`).toBe('paragraph');
    }

    await page.locator('#pe-find-input').press('Enter');
    await expect(page.locator('#pe-find-count')).toHaveText('2 / 5');
    await expect(page.locator('#pe-highlights .pe-hl[data-current="true"]')).toHaveCount(1);
    await page.locator('#pe-find-input').press('Escape');
    await expect(page.locator('#pe-highlights')).toHaveCount(0);
  });
});

test(`[integration] Ctrl+F: Korean search term (m0-spike-saved.pdf '검색과 복사' 1 hit)`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-spike-saved.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('검색과 복사');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 1');
    await expect(page.locator('#pe-highlights .pe-hl')).toHaveCount(1);
  });
});

test(`[integration] layout overlay: draws paragraph boxes and reading order from the Worker getPageLayout result`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await page.locator('#pe-overlay-toggle').click();
    const canvas = page.locator('#pe-layout-canvas');
    await expect(canvas).toHaveAttribute('data-paragraphs', /^[1-9]\d*$/, { timeout: 20_000 });
    expect(Number(await canvas.getAttribute('data-order'))).toBeGreaterThan(0);
    await page.locator('#pe-overlay-toggle').click();
    await expect(canvas).toHaveCount(0);
  });
});

test(`[integration] debug overlay: glyph quad color coding and SourceOp display for the glyph under the mouse`, async () => {
  await withExtension(async (env) => {
    // The debug overlay has no toolbar button, so it is turned on through the `?e2e` seam (user request 2026-10-22).
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/viewer.html?e2e`);
    await page.locator('#open-file').setInputFiles(join(DIST, 'diag/m0-sample.pdf'));
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 20_000,
    });
    expect(await extractOutcome(page)).toBe('text-layer');
    await expect(page.locator('#pe-debug-toggle')).toHaveCount(0);
    await toggleDebug(page);
    const canvas = page.locator('#pe-debug-canvas');
    await expect(canvas).toHaveCount(1);
    const counts = await canvas.evaluate((c) => ({
      matched: Number(c.getAttribute('data-matched')),
      limited: Number(c.getAttribute('data-limited')),
      unmatched: Number(c.getAttribute('data-unmatched')),
    }));
    // The synthetic document (m0-sample) is a simple Tj content, so there must be no match failures (adjust the baseline after measuring).
    expect(counts.matched + counts.limited).toBeGreaterThan(0);
    expect(counts.unmatched).toBe(0);
    const first = await boxOf(page.locator('#pe-text-layer span[data-i]').first());
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    const tip = page.locator('#pe-debug-tip');
    await expect(tip).toContainText('연산 #');
    await expect(tip).toContainText('범위 ');
    await expect(tip).toContainText('제한: ');
  });
});
