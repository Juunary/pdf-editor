/**
 * Page left/right previous/next arrow e2e (docs/m3-viewer-ui.md page navigation).
 *
 * 1) Fake edit host harness: back/forward navigation on a 3-page document, disabled arrow on the end pages, toolbar linkage, commit first when navigating during editing.
 * 2) Extension integration: opens a 3-page PDF built in the test in the plain viewer and embedded (iframe, embed) and checks navigation and layout (does not cover the page or text layer,
 *    no horizontal overflow, narrow widths).
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editModel, openEditHarness, startEditHarness, stopEditHarness } from './edit-harness.js';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

// ══ 1. Harness ═══════════════════════════════════════════════════════

const PARAGRAPHS = [
  { id: 1, bbox: [20, 20, 130, 60] as [number, number, number, number], text: 'Hello World' },
];

test.describe('page arrows (fake edit host, 3 pages)', () => {
  test.beforeAll(startEditHarness);
  test.afterAll(stopEditHarness);

  let errors: string[] = [];
  test.beforeEach(async ({ page }) => {
    errors = await openEditHarness(page, {
      model: editModel(),
      paragraphs: PARAGRAPHS,
      cssScale: 1.5,
      pageCount: 3,
    });
    await page.waitForSelector('#pe-text-layer');
    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __controller: { getState(): { edit: { editability: { status: string } } } };
          }
        ).__controller.getState().edit.editability.status === 'ready',
    );
  });
  test.afterEach(() => {
    expect(errors, '페이지 오류').toEqual([]);
  });

  const shownPage = (page: Page) => page.locator('#pe-page-input');

  test('back/forward navigation, disabled on the end pages, linked to the toolbar page number', async ({
    page,
  }) => {
    const prev = page.locator('#pe-arrow-prev');
    const next = page.locator('#pe-arrow-next');
    await expect(prev).toBeVisible();
    await expect(next).toBeVisible();
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await expect(shownPage(page)).toHaveValue('1');
    await next.click();
    await expect(page.locator('#pe-page')).toHaveAttribute('data-page-index', '1');
    await expect(shownPage(page)).toHaveValue('2');
    await expect(prev).toBeEnabled();
    await expect(next).toBeEnabled();
    await next.click();
    await expect(page.locator('#pe-page')).toHaveAttribute('data-page-index', '2');
    await expect(shownPage(page)).toHaveValue('3');
    await expect(next).toBeDisabled();
    await expect(page.locator('#pe-next')).toBeDisabled();
    await prev.click();
    await prev.click();
    await expect(page.locator('#pe-page')).toHaveAttribute('data-page-index', '0');
    await expect(prev).toBeDisabled();
    await expect(page.locator('#pe-prev')).toBeDisabled();
    // Navigating with the toolbar input also makes the arrow state follow.
    await shownPage(page).fill('3');
    await shownPage(page).press('Enter');
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
  });

  test('arrows are at least 48×96 and default, hover and disabled looks are distinguishable (user request 2026-10-23)', async ({
    page,
  }) => {
    const prev = page.locator('#pe-arrow-prev');
    const next = page.locator('#pe-arrow-next');
    for (const el of [prev, next]) {
      const box = (await el.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(96);
      await expect(el.locator('svg')).toHaveCount(1);
    }
    const look = (sel: string) =>
      page.evaluate((s) => {
        const cs = getComputedStyle(document.querySelector(s)!);
        return `${cs.backgroundColor} ${cs.color} ${cs.borderColor}`;
      }, sel);
    await page.mouse.move(1, 1);
    const enabled = await look('#pe-arrow-next');
    const disabled = await look('#pe-arrow-prev'); // first page
    expect(disabled).not.toBe(enabled);
    // The default plate is 88% opaque (previously: #4a4f54, almost the same as the background).
    expect(enabled).toContain('rgba(32, 33, 36, 0.88)');
    await next.hover();
    expect(await look('#pe-arrow-next')).not.toBe(enabled);
  });

  test('left/right arrow keys do not turn pages (avoids conflict with caret movement)', async ({
    page,
  }) => {
    await page.locator('#pe-page').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#pe-page')).toHaveAttribute('data-page-index', '0');
  });

  test('arrows are outside the page and text layer area, and clicking the page center is not intercepted by the arrows', async ({
    page,
  }) => {
    const pageBox = (await page.locator('#pe-page').boundingBox())!;
    const prev = (await page.locator('#pe-arrow-prev').boundingBox())!;
    const next = (await page.locator('#pe-arrow-next').boundingBox())!;
    expect(prev.x + prev.width).toBeLessThanOrEqual(pageBox.x);
    expect(next.x).toBeGreaterThanOrEqual(pageBox.x + pageBox.width);
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('#pe-page, .pe-arrow')?.id ?? null,
      [pageBox.x + pageBox.width / 2, pageBox.y + 100],
    );
    expect(hit).toBe('pe-page');
  });

  test('pressing an arrow during editing commits the draft first and navigates', async ({
    page,
  }) => {
    const box = (await page.locator('#pe-page').boundingBox())!;
    const scale = 1.5;
    await page.mouse.dblclick(box.x + (20 + 6 * 10 + 2) * scale, box.y + 27 * scale);
    await page.waitForSelector('#pe-edit-layer');
    await page.keyboard.type('abc');
    await page.waitForFunction(() => {
      const s = (
        window as unknown as {
          __controller: {
            getState(): {
              edit: { session: { updating: boolean; editor: { text: string } } | null };
            };
          };
        }
      ).__controller.getState().edit.session;
      return !!s && !s.updating && s.editor.text.includes('abc');
    });
    const commits = () =>
      page.evaluate(() =>
        (window as unknown as { __edit: { count(m: string): number } }).__edit.count(
          'commitParagraphEdit',
        ),
      );
    expect(await commits()).toBe(0);
    await page.locator('#pe-arrow-next').click();
    await expect(page.locator('#pe-page')).toHaveAttribute('data-page-index', '1');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    expect(await commits()).toBe(1);
    await expect(page.locator('#pe-doc-undo')).toBeEnabled(); // the committed edit is in the document history
  });
});

// ══ 2. Extension integration (3-page PDF built in the test) ═══════════════════════════════════

/** n-page PDF with one line of Helvetica per page (page 612 × heightPt pt). */
function makePdf(n: number, heightPt = 792): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 24 Tf 72 ${heightPt - 92} Td (Page ${i + 1} navigation sample) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${heightPt}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Only one viewer per page (focus movement between multiple viewers is unstable in headless). */
const HOSTS: Record<string, string> = {
  iframe800: '<iframe src="/multi.pdf" style="width:800px;height:560px;border:1px solid #888">',
  iframe480: '<iframe src="/multi.pdf" style="width:480px;height:560px;border:1px solid #888">',
  embed: '<embed src="/multi.pdf" type="application/pdf" style="width:800px;height:560px">',
};

function servePdf(): Promise<{ server: Server; base: string }> {
  const pdf = makePdf(3);
  // Tall page (612 × 1584 pt, 2.6 times the width): the page is much longer than the document area at any window size.
  const tall = makePdf(2, 1584);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/multi.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
    } else if (path === '/tall.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(tall);
    } else if (path === '/host.html') {
      const kind = new URL(req.url ?? '/', 'http://x').searchParams.get('kind') ?? '';
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><meta charset="utf-8"><body style="margin:8px">${HOSTS[kind] ?? ''}`);
    } else {
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

async function withExtension<T>(
  fn: (env: { context: BrowserContext; extensionId: string; base: string }) => Promise<T>,
): Promise<T> {
  const { server, base } = await servePdf();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-nav-'));
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

async function waitRendered(frame: Frame): Promise<void> {
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  await frame.locator('#pe-text-layer').waitFor({ timeout: 20_000 });
}

async function navigateAndCheck(frame: Frame): Promise<void> {
  const prev = frame.locator('#pe-arrow-prev');
  const next = frame.locator('#pe-arrow-next');
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(frame.locator('#pe-page-input')).toHaveValue('2');
  await expect(frame.locator('#pe-page')).toHaveAttribute('data-page-index', '1');
  await frame.locator('#pe-text-layer').waitFor();
  await expect(prev).toBeEnabled();
  await next.click();
  await expect(frame.locator('#pe-page-input')).toHaveValue('3');
  await expect(next).toBeDisabled();
  await prev.click();
  await prev.click();
  await expect(frame.locator('#pe-page-input')).toHaveValue('1');
  await expect(prev).toBeDisabled();
}

/** The two arrow boxes, the page canvas box, and the visible range of the document area (including inner padding, excluding the scrollbar). All in viewport coordinates. */
async function arrowGeometry(page: Page) {
  return page.evaluate(() => {
    const c = document.getElementById('page-container')!;
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const cr = c.getBoundingClientRect();
    const visLeft = cr.left + c.clientLeft;
    const visTop = cr.top + c.clientTop;
    return {
      placement: c.dataset.peArrows ?? null,
      clientWidth: c.clientWidth,
      scrollWidth: c.scrollWidth,
      scroll: { left: c.scrollLeft, top: c.scrollTop },
      maxScroll: { left: c.scrollWidth - c.clientWidth, top: c.scrollHeight - c.clientHeight },
      visible: {
        left: visLeft,
        top: visTop,
        right: visLeft + c.clientWidth,
        bottom: visTop + c.clientHeight,
      },
      canvas: box('page-canvas'),
      prev: box('pe-arrow-prev'),
      next: box('pe-arrow-next'),
    };
  });
}

type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;
const inside = (a: Box, b: Box) =>
  a.left >= b.left - 0.5 &&
  a.right <= b.right + 0.5 &&
  a.top >= b.top - 0.5 &&
  a.bottom <= b.bottom + 0.5;

/** Inner padding of the document area (viewer.css #page-container padding). In the overlap layout the arrows are within this at the end of the visible range. */
const AREA_PADDING = 16;

type Geometry = Awaited<ReturnType<typeof arrowGeometry>>;

function checkPlacement(g: Geometry, tag: string): void {
  // Classification criterion (page-nav.ts pageArrowLayout): a document area of 464 px or more gets left/right slots, otherwise the arrows overlap the page.
  expect(g.placement, tag).toBe(g.clientWidth >= 464 ? 'side' : 'overlay');
  if (g.placement === 'side') {
    expect(overlaps(g.prev, g.canvas), `${tag}: 이전 화살표 × 쪽`).toBe(false);
    expect(overlaps(g.next, g.canvas), `${tag}: 다음 화살표 × 쪽`).toBe(false);
    expect(g.scrollWidth, `${tag}: 가로 넘침 없음`).toBeLessThanOrEqual(g.clientWidth);
    return;
  }
  // Overlap (changed by user decision 2026-10-26): both arrows are inside the visible range, previous at the left end and next at the right end, overlapping the page.
  expect(inside(g.prev, g.visible), `${tag}: 이전 화살표가 보이는 범위 안`).toBe(true);
  expect(inside(g.next, g.visible), `${tag}: 다음 화살표가 보이는 범위 안`).toBe(true);
  expect(g.prev.left - g.visible.left, `${tag}: 이전은 왼쪽 끝`).toBeLessThanOrEqual(
    AREA_PADDING + 0.5,
  );
  expect(g.visible.right - g.next.right, `${tag}: 다음은 오른쪽 끝`).toBeLessThanOrEqual(
    AREA_PADDING + 0.5,
  );
  expect(overlaps(g.prev, g.canvas), `${tag}: 이전 화살표가 쪽 위`).toBe(true);
  expect(overlaps(g.next, g.canvas), `${tag}: 다음 화살표가 쪽 위`).toBe(true);
  // Page width = document area − padding (minimum 320), without subtracting the slot share. Horizontal overflow only as much as the page minimum width causes.
  const pageWidth = g.canvas.right - g.canvas.left;
  expect(Math.abs(pageWidth - Math.max(320, g.clientWidth - 32)), `${tag}: 쪽 폭`).toBeLessThan(
    1.5,
  );
  const minOverflow = Math.max(0, 320 + 2 * AREA_PADDING - g.clientWidth);
  expect(
    g.scrollWidth - g.clientWidth,
    `${tag}: 가로 넘침은 쪽 최소 폭 때문만`,
  ).toBeLessThanOrEqual(minOverflow + 1);
}

test('[integration] window width 320, 400, 464, 800 px: when wide the arrows sit in slots left and right outside the page, when narrow they overlap the page at the left and right ends of the visible range', async () => {
  await withExtension(async (env) => {
    const page = await env.context.newPage();
    for (const width of [320, 400, 464, 800]) {
      // Lower the height so it also overflows vertically (check that the arrows stay within the visible range even when scrolled to the vertical end).
      await page.setViewportSize({ width, height: 480 });
      await page.goto(
        `chrome-extension://${env.extensionId}/viewer.html?file=${env.base}/multi.pdf`,
      );
      await waitRendered(page.mainFrame());
      const g = await arrowGeometry(page);
      const tag = `${width} px (문서 영역 ${g.clientWidth} px, ${g.placement})`;
      expect(g.maxScroll.top, `${tag}: 세로 넘침(시험 전제)`).toBeGreaterThan(0);
      checkPlacement(g, tag);
      // The same conditions hold even when scrolled to the horizontal and vertical ends.
      await page.evaluate(() => {
        const c = document.getElementById('page-container')!;
        c.scrollLeft = c.scrollWidth;
        c.scrollTop = c.scrollHeight;
      });
      const end = await arrowGeometry(page);
      expect(end.scroll, `${tag}: 끝까지 스크롤`).toEqual(end.maxScroll);
      checkPlacement(end, `${tag} 끝까지 스크롤 뒤`);
      if (g.placement === 'overlay') {
        // The page center outside the arrows and the point just inside the arrows are received by the page (the slot does not intercept the pointer).
        const hits = await page.evaluate(
          ({ prev, next, canvas }) => {
            const at = (x: number, y: number) => {
              const el = document.elementFromPoint(x, y);
              return {
                page: el?.closest('#pe-page') !== null,
                arrow: el?.closest('.pe-arrow-slot') !== null,
              };
            };
            const midY = (prev.top + prev.bottom) / 2;
            return {
              center: at((canvas.left + canvas.right) / 2, (canvas.top + canvas.bottom) / 2),
              besidePrev: at(prev.right + 4, midY),
              besideNext: at(next.left - 4, midY),
              abovePrev: at((prev.left + prev.right) / 2, prev.top - 4),
            };
          },
          { prev: end.prev, next: end.next, canvas: end.canvas },
        );
        for (const [where, h] of Object.entries(hits)) {
          expect(h, `${tag}: ${where} 은 쪽이 받음`).toEqual({ page: true, arrow: false });
        }
        // A real click also goes to the page (no page navigation, the click target is inside the page).
        await page.evaluate(() => {
          const w = window as unknown as { __clickTarget: string | null };
          w.__clickTarget = null;
          document.addEventListener(
            'click',
            (e) => {
              w.__clickTarget =
                (e.target as Element | null)?.closest('#pe-page') !== null ? 'page' : 'other';
            },
            { capture: true, once: true },
          );
        });
        const c = end.canvas;
        const visCenterX =
          (Math.max(c.left, end.visible.left) + Math.min(c.right, end.visible.right)) / 2;
        const visCenterY =
          (Math.max(c.top, end.visible.top) + Math.min(c.bottom, end.visible.bottom)) / 2;
        await page.mouse.click(visCenterX, visCenterY);
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as { __clickTarget: string | null }).__clickTarget,
            ),
          )
          .toBe('page');
        await expect(page.locator('#pe-page-input'), tag).toHaveValue('1');
        // Navigate pages with the arrows (staying scrolled to the end).
        await navigateAndCheck(page.mainFrame());
      }
    }
  });
});

/** Allowed tolerance of the arrow vertical center (px). */
const CENTER_TOLERANCE = 8;

test('[integration] scrolling a long page to the top, middle and end: both arrows stay at the vertical center of the visible range of the document area', async () => {
  await withExtension(async (env) => {
    const page = await env.context.newPage();
    const sizes: [number, number][] = [
      [800, 480],
      [1280, 600],
      [400, 480],
      [320, 480],
    ];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `chrome-extension://${env.extensionId}/viewer.html?file=${env.base}/tall.pdf`,
      );
      await waitRendered(page.mainFrame());
      const g = await arrowGeometry(page);
      const tag = `${width}×${height} (문서 영역 ${g.clientWidth} px, ${g.placement})`;
      // Test premise: the page is much longer than the document area (overflows by at least the visible height).
      expect(g.maxScroll.top, `${tag}: 세로 넘침`).toBeGreaterThan(
        g.visible.bottom - g.visible.top,
      );
      // The arrows do not extend the scroll range: vertical scroll height = page height + top/bottom padding.
      const canvasHeight = g.canvas.bottom - g.canvas.top;
      expect(
        Math.abs(
          g.maxScroll.top + (g.visible.bottom - g.visible.top) - (canvasHeight + 2 * AREA_PADDING),
        ),
        `${tag}: 세로 스크롤 높이`,
      ).toBeLessThanOrEqual(1);
      for (const [where, frac] of [
        ['맨 위', 0],
        ['가운데', 0.5],
        ['끝', 1],
      ] as const) {
        await page.evaluate((f) => {
          const c = document.getElementById('page-container')!;
          c.scrollTop = Math.round((c.scrollHeight - c.clientHeight) * f);
          c.scrollLeft = Math.round((c.scrollWidth - c.clientWidth) * f);
        }, frac);
        const s = await arrowGeometry(page);
        const at = `${tag} ${where}(scrollTop ${s.scroll.top}/${s.maxScroll.top})`;
        expect(s.scroll.top, `${at}: 스크롤 위치`).toBe(Math.round(s.maxScroll.top * frac));
        checkPlacement(s, at);
        const visMid = (s.visible.top + s.visible.bottom) / 2;
        for (const [name, b] of [
          ['이전', s.prev],
          ['다음', s.next],
        ] as const) {
          expect(inside(b, s.visible), `${at}: ${name} 화살표가 보이는 범위 안`).toBe(true);
          expect(
            Math.abs((b.top + b.bottom) / 2 - visMid),
            `${at}: ${name} 화살표 세로 가운데(위 ${b.top.toFixed(1)}, 보이는 범위 ${s.visible.top}–${s.visible.bottom})`,
          ).toBeLessThanOrEqual(CENTER_TOLERANCE);
        }
        // The slot does not receive the pointer: the points just above and below the button are received by the page (overlay) or the document area (side), not by the slot.
        const hits = await page.evaluate(
          ({ prev, next }) =>
            [prev, next].flatMap((b) =>
              [b.top - 4, b.bottom + 4].map((y) => {
                const el = document.elementFromPoint((b.left + b.right) / 2, y);
                return {
                  slot: el?.closest('.pe-arrow-slot') !== null,
                  page: el?.closest('#pe-page') !== null,
                };
              }),
            ),
          { prev: s.prev, next: s.next },
        );
        for (const h of hits) {
          expect(h, `${at}: 버튼 밖은 칸이 받지 않음`).toEqual({
            slot: false,
            page: s.placement === 'overlay',
          });
        }
      }
    }
  });
});

test('[integration] plain viewer: navigate a 3-page PDF back and forth with the arrows', async () => {
  await withExtension(async (env) => {
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/viewer.html?file=${env.base}/multi.pdf`);
    await waitRendered(page.mainFrame());
    await expect(page.locator('#pe-page-count')).toHaveText('/ 3');
    await navigateAndCheck(page.mainFrame());
  });
});

test('[integration] embedded (iframe 800 and 480 widths, embed): arrows are visible and do not cover the page or text selection', async () => {
  await withExtension(async (env) => {
    const prefix = `chrome-extension://${env.extensionId}/viewer.html`;
    for (const kind of Object.keys(HOSTS)) {
      const host = await env.context.newPage();
      await host.goto(`${env.base}/host.html?kind=${kind}`);
      await expect
        .poll(() => host.frames().filter((f) => f.url().startsWith(prefix)).length)
        .toBe(1);
      const f = host.frames().find((x) => x.url().startsWith(prefix))!;
      const tag = kind;
      await waitRendered(f);
      await expect(f.locator('body')).toHaveClass(/embedded/);
      const prev = f.locator('#pe-arrow-prev');
      const next = f.locator('#pe-arrow-next');
      await expect(prev, tag).toBeVisible();
      await expect(next, tag).toBeVisible();
      const geometry = await f.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const pageBox = r('#pe-page');
        const p = r('#pe-arrow-prev');
        const n = r('#pe-arrow-next');
        const span = document.querySelector('#pe-text-layer span[data-i]')!.getBoundingClientRect();
        const hit = document.elementFromPoint(span.x + span.width / 2, span.y + span.height / 2);
        return {
          prevRight: p.right,
          nextLeft: n.left,
          pageLeft: pageBox.left,
          pageRight: pageBox.right,
          prevLeft: p.left,
          nextRight: n.right,
          viewWidth: document.getElementById('page-container')!.clientWidth,
          scrollWidth: document.getElementById('page-container')!.scrollWidth,
          textHit: hit?.closest('#pe-text-layer') !== null,
        };
      });
      expect(geometry.prevRight, `${tag}: 이전 화살표는 쪽 왼쪽`).toBeLessThanOrEqual(
        geometry.pageLeft + 0.5,
      );
      expect(geometry.nextLeft, `${tag}: 다음 화살표는 쪽 오른쪽`).toBeGreaterThanOrEqual(
        geometry.pageRight - 0.5,
      );
      expect(geometry.prevLeft, tag).toBeGreaterThanOrEqual(0);
      expect(geometry.nextRight, tag).toBeLessThanOrEqual(geometry.viewWidth + 16);
      expect(geometry.scrollWidth, `${tag}: 가로 넘침 없음`).toBeLessThanOrEqual(
        geometry.viewWidth,
      );
      expect(geometry.textHit, `${tag}: 텍스트 위 포인터는 텍스트 층`).toBe(true);
      // Text selection and copy still work (focus by clicking a glyph, then Ctrl+A, Ctrl+C).
      await f.evaluate(() => {
        (window as unknown as { __copied: string | null }).__copied = null;
        window.addEventListener('copy', (e) => {
          (window as unknown as { __copied: string | null }).__copied =
            e.clipboardData?.getData('text/plain') ?? null;
        });
      });
      await f.locator('#pe-text-layer span[data-i]').first().click({ force: true });
      await expect.poll(() => f.evaluate(() => document.hasFocus()), { message: tag }).toBe(true);
      await host.keyboard.press('Control+A');
      await host.keyboard.press('Control+C');
      await expect
        .poll(() => f.evaluate(() => (window as unknown as { __copied: string | null }).__copied), {
          message: tag,
        })
        .toContain('navigation sample');
      await navigateAndCheck(f);
      await host.close();
    }
  });
});
