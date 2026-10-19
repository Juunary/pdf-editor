/**
 * M1 viewer-ui e2e (docs/m1-viewer-ui.md).
 *
 * 1) 하니스 테스트: 합성 PageModel 과 가짜 호스트로 viewer-ui 빌드 산출물만 띄워 DOM 동작(텍스트 층 배치,
 *    드래그 선택·복사, Ctrl+F, 하이라이트, 디버그 오버레이, 기능 비활성화)을 실제 Chromium 에서 확인한다.
 * 2) 통합 시나리오(2026-10-19 m1 통합 후 활성화): 빌드된 확장에서 실제 core 추출·검색과 pdf-ops 매칭으로
 *    선택·복사(일반 뷰어·MIME handler 최상위·임베디드), Ctrl+F, 디버그 오버레이를 확인한다(docs/m1-integration.md).
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
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import {
  makeLinkage,
  makePageModel,
  makeSourceMap,
  makeTextOp,
} from '../../../packages/viewer-ui/test/fixtures.js';

// ── 공통 ──────────────────────────────────────────────────────────────

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const UI_ROOT = fileURLToPath(new URL('../../../packages/viewer-ui/', import.meta.url));

/** 포인터 좌표를 읽을 때 쓰는 허용 오차(CSS px). 서브픽셀 반올림·transform 반올림 여유. */
const PX = 0.75;

// ══ 1. 하니스 ═════════════════════════════════════════════════════════

interface HarnessConfig {
  pages: PageModel[];
  maps?: SourceMap[];
  linkages?: PageLinkage[];
  /** 호스트 호출이 던질 오류 메시지. */
  failures?: { extract?: string; search?: string; link?: string };
  /** pt → CSS px 고정 배율. */
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

/** 페이지에서 실행되는 하니스 스크립트(순수 JS). 가짜 호스트로 viewer-ui 를 마운트한다. */
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
    // window 리스너는 document 리스너(텍스트 층의 copy 처리) 뒤에 실행되므로 최종 복사 텍스트를 읽는다.
    window.addEventListener('copy', (e) => {
      (window as Win).__copied = e.clipboardData?.getData('text/plain') ?? null;
    });
  });
  expect(errors, '하니스 페이지 오류').toEqual([]);
}

/** 합성 페이지. 글자 10×14pt, 줄 간격 20pt, 왼쪽 20pt, 위쪽 20pt. */
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

/** 합성 페이지의 글자 위치(pt) → 화면 좌표. fx·fy 는 글자 상자 안 비율. */
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

test.describe('viewer-ui 하니스(합성 PageModel, 가짜 호스트)', () => {
  test.beforeAll(startHarnessServer);
  test.afterAll(() => harnessServer.close());

  test('텍스트 층: 글자 span 이 quad × 배율 위치·크기에 놓이고 DOM 순서가 읽기 순서다', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    expect(g.scale).toBe(1.5);
    const spans = page.locator('#pe-text-layer span[data-i]');
    expect(await spans.count()).toBe(PAGE_0.chars.length);
    // DOM 순서의 글자 = 읽기 순서의 글자
    const domText = await spans.evaluateAll((els) => els.map((e) => e.textContent).join(''));
    expect(domText).toBe(LINES.map((l) => l.text).join(''));
    // 모든 글자 상자가 quad 위치·크기와 일치(scaleX 로 폭을 맞춘다)
    for (const [idx, char] of PAGE_0.chars.entries()) {
      const [x0, y0, x1, , , y2] = char.quad;
      expectBox(
        await boxOf(spans.nth(idx)),
        { x: g.x + x0 * 1.5, y: g.y + y0 * 1.5, width: (x1 - x0) * 1.5, height: (y2 - y0) * 1.5 },
        `글자 #${idx} "${char.text}"`,
      );
    }
    // 글자는 투명
    const color = await spans.first().evaluate((e) => getComputedStyle(e).color);
    expect(color).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test.describe('devicePixelRatio 2', () => {
    test.use({ deviceScaleFactor: 2 });

    test('캔버스 비트맵은 dpr 배, 오버레이는 CSS px 그대로', async ({ page }) => {
      await openHarness(page, baseConfig());
      const canvas = page.locator('#page-canvas');
      const attrs = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
      // 페이지 600×800pt × 1.5(CSS 배율) × 2(dpr)
      expect(attrs).toEqual({ w: 1800, h: 2400 });
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
      const box = await boxOf(page.locator('#pe-page'));
      expect([box.width, box.height]).toEqual([900, 1200]);
      const first = await boxOf(page.locator('#pe-text-layer span[data-i="0"]'));
      expectBox(first, { x: box.x + 30, y: box.y + 30, width: 15, height: 21 }, 'dpr 2 첫 글자');
    });
  });

  test('드래그 선택 → Ctrl+C: 줄 사이를 가로지르는 텍스트가 읽기 순서로 복사된다', async ({
    page,
  }, testInfo) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    // 1줄 'W'(6번) 왼쪽 절반 → 2줄 'd'(5번) 오른쪽 절반
    await drag(page, charAt(g, 0, 6, 0.2), charAt(g, 1, 5, 0.8));
    expect(await copied(page)).toBe('World\nSecond');
    // 하이라이트: 줄마다 상자 하나, 선택된 글자 범위의 quad × 배율(줄바꿈 표식과 겹친 줄무늬 없음)
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
    // 선택을 지우면 하이라이트도 사라진다
    await page.mouse.click(g.x + 5, g.y + 5);
    await expect(rects).toHaveCount(0);
  });

  test('블록 경계를 넘으면 빈 줄이 들어간다', async ({ page }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    await drag(page, charAt(g, 1, 7, 0.2), charAt(g, 2, 1, 0.8)); // 'line here' … '한글'
    expect(await copied(page)).toBe('line here\n\n한글');
  });

  test('줄 끝 바깥·줄 사이·텍스트 아래로 끌어도 선택이 튀지 않는다', async ({ page }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    const start = charAt(g, 0, 6, 0.2);
    // 2줄 오른쪽 빈 곳(줄 끝 바깥)
    await drag(page, start, { x: g.x + 580 * g.scale, y: charAt(g, 1, 0).y });
    expect(await copied(page)).toBe('World\nSecond line here');
    // 1줄(20–34pt)과 2줄(40–54pt) 사이 빈 틈, 1줄 쪽에 가까운 y = 35pt 의 1줄 끝 글자 오른쪽 절반
    await drag(page, start, { x: charAt(g, 0, 10, 0.9).x, y: g.y + 35 * g.scale });
    expect(await copied(page)).toBe('World');
    // 텍스트 전체 아래
    await drag(page, start, { x: g.x + 300 * g.scale, y: g.y + 700 * g.scale });
    expect(await copied(page)).toBe('World\nSecond line here\n\n한글 문단 하나');
  });

  test('거꾸로(위쪽으로) 끌어도 같은 구간이 선택된다', async ({ page }) => {
    await openHarness(page, baseConfig());
    const g = await geo(page);
    await drag(page, charAt(g, 1, 3, 0.2), charAt(g, 0, 2, 0.2));
    expect(await copied(page)).toBe('llo World\nSec');
  });

  test('더블클릭 = 단어, 트리플클릭 = 줄, Ctrl+A = 전체, 클릭 = 선택 해제', async ({ page }) => {
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
    // 한 번 클릭하면 선택이 사라진다
    await page.mouse.click(inWorld.x, inWorld.y);
    expect(await page.evaluate(() => document.getSelection()?.isCollapsed ?? true)).toBe(true);
  });

  test('합성 공백(spaceAfter): 복사에 공백이 들어가고 DOM 줄 텍스트·단어 경계도 맞다', async ({
    page,
  }) => {
    // TJ 간격으로 단어를 나눈 문서처럼 공백 글리프가 없고 구조화 텍스트의 합성 공백만 있는 줄
    const latex = makePageModel([
      { text: 'foobarbaz', block: 1, spaceAfter: [2, 5] },
      { text: 'tail', block: 1 },
    ]);
    await openHarness(page, { pages: [latex], cssScale: 1.5 });
    const g = await geo(page);

    // DOM: 합성 공백은 글자 span 과 구분되는 별도 요소이고, 줄 텍스트에 공백이 들어간다.
    await expect(page.locator('#pe-text-layer span[data-i]')).toHaveCount(13);
    await expect(page.locator('#pe-text-layer span[data-space]')).toHaveCount(2);
    expect(
      await page
        .locator('#pe-text-layer .pe-line')
        .evaluateAll((lines) => lines.map((l) => l.textContent)),
    ).toEqual(['foo bar baz', 'tail']);

    // 전체 선택: 줄 끝 공백 없이 "foo bar baz\ntail"
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe('foo bar baz\ntail');
    // 드래그: 양옆 글자가 모두 선택에 든 공백만 들어간다
    await drag(page, charAt(g, 0, 1, 0.2), charAt(g, 0, 7, 0.8));
    expect(await copied(page)).toBe('oo bar ba');
    await drag(page, charAt(g, 0, 3, 0.2), charAt(g, 0, 5, 0.8));
    expect(await copied(page)).toBe('bar');
    // 더블클릭: 합성 공백이 단어 경계
    const inBar = charAt(g, 0, 4);
    await page.mouse.dblclick(inBar.x, inBar.y);
    expect(await copied(page)).toBe('bar');
    // 하이라이트는 공백 자리를 포함해 이어진다(첫 줄 9자 = 90pt)
    await page.keyboard.press('Control+A');
    const rects = page.locator('#pe-selection .pe-sel');
    await expect(rects).toHaveCount(2);
    expectBox(
      await boxOf(rects.nth(0)),
      { x: g.x + 20 * 1.5, y: g.y + 20 * 1.5, width: 90 * 1.5, height: 14 * 1.5 },
      '합성 공백 줄 선택',
    );
  });

  test('선택 영역 밖(툴바)의 복사는 가로채지 않는다', async ({ page }) => {
    await openHarness(page, baseConfig());
    await page.locator('#pe-page-input').fill('1');
    await page.locator('#pe-page-input').selectText();
    await page.evaluate(() => {
      (window as Win).__copied = null;
    });
    await page.keyboard.press('Control+C');
    // 입력란 복사는 text/plain 을 우리가 채우지 않으므로 읽을 값이 없다.
    expect(await page.evaluate(() => (window as Win).__copied ?? '')).toBe('');
  });

  test('실제 클립보드에도 복사 텍스트가 들어간다', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openHarness(page, baseConfig());
    const g = await geo(page);
    await drag(page, charAt(g, 0, 0, 0.2), charAt(g, 0, 4, 0.8));
    await page.keyboard.press('Control+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 3000 })
      .toBe('Hello');
  });

  test('페이지 이동: 이전·다음·번호 입력, 잘못된 입력은 되돌린다', async ({ page }) => {
    await openHarness(page, baseConfig());
    const input = page.locator('#pe-page-input');
    await expect(input).toHaveValue('1');
    await expect(page.locator('#pe-page-count')).toHaveText('/ 2');
    await expect(page.locator('#pe-prev')).toBeDisabled();
    await page.locator('#pe-next').click();
    await expect(page.locator('body')).toHaveAttribute('data-painted', '1');
    await expect(input).toHaveValue('2');
    await expect(page.locator('#pe-next')).toBeDisabled();
    await expect(page.locator('#pe-text-layer span[data-i="0"]')).toHaveText('A'); // 2페이지 텍스트
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

  test('Ctrl+F: 검색창·결과 수·이전/다음·하이라이트 위치 = quad × 배율·페이지 이동', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    await page.keyboard.press('Control+F');
    const find = page.locator('#pe-find-input');
    await expect(find).toBeFocused();
    await find.fill('Hello');
    const count = page.locator('#pe-find-count');
    await expect(count).toHaveText('1 / 3');

    // 현재 페이지(0) 결과 1건, 위치가 quad × 배율과 일치
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

    // Enter: 다음 결과는 2페이지. 페이지가 이동하고 2페이지의 결과 2건이 칠해진다.
    await find.press('Enter');
    await expect(count).toHaveText('2 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');
    await expect(highlights).toHaveCount(2);
    await expect(page.locator('#pe-highlights .pe-hl[data-current="true"]')).toHaveCount(1);
    await find.press('Enter');
    await expect(count).toHaveText('3 / 3');
    // 순환: 3 → 1(1페이지)
    await find.press('Enter');
    await expect(count).toHaveText('1 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('1');
    // Shift+Enter: 1 → 3(2페이지)
    await find.press('Shift+Enter');
    await expect(count).toHaveText('3 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');

    // 버튼
    await page.locator('#pe-find-prev').click();
    await expect(count).toHaveText('2 / 3');
    await page.locator('#pe-find-next').click();
    await expect(count).toHaveText('3 / 3');

    // Esc: 닫기, 하이라이트 제거
    await find.press('Escape');
    await expect(page.locator('#pe-find')).toHaveCount(0);
    await expect(page.locator('#pe-highlights')).toHaveCount(0);
  });

  test('Ctrl+F: 현재 페이지부터 검색한다(2페이지에서 시작하면 2페이지 결과가 먼저)', async ({
    page,
  }) => {
    await openHarness(page, baseConfig());
    await page.locator('#pe-next').click();
    await expect(page.locator('body')).toHaveAttribute('data-painted', '1');
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('hello');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 3');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');
    // 2페이지 1줄 'Another page with Hello' 의 'Hello'(18–22번 글자)
    await expect(page.locator('#pe-highlights .pe-hl[data-current="true"]')).toHaveAttribute(
      'data-quad',
      '200,20,250,20,200,34,250,34',
    );
  });

  test('Ctrl+F: 대소문자 구분·결과 없음·검색창 다시 열기', async ({ page }) => {
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
    // Ctrl+F 를 다시 누르면 입력란에 포커스·전체 선택
    await page.locator('#pe-page-input').focus();
    await page.keyboard.press('Control+F');
    await expect(find).toBeFocused();
    expect(await find.evaluate((e: HTMLInputElement) => e.selectionEnd! - e.selectionStart!)).toBe(
      3,
    );
  });

  test('Ctrl+F: 현재 결과가 화면 밖(스크롤 아래)이면 화면 안으로 스크롤한다', async ({ page }) => {
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
    // 첫 줄 결과로 돌아가면 위로 스크롤한다
    await page.locator('#pe-find-input').fill('top');
    await expect(current).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(100);
  });

  test('디버그 오버레이: 매칭 여부 색 구분·요약·마우스 위치 글자의 SourceOp', async ({
    page,
  }, testInfo) => {
    // 글자 매칭: 1줄(11자) → 연산 0, 2줄 앞 3글자 → 실패(-1), 2줄 나머지 13자 → 연산 1(편집 제한), 3줄(8자) → 연산 2
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
    await page.locator('#pe-debug-toggle').click();
    const canvas = page.locator('#pe-debug-canvas');
    await expect(canvas).toHaveAttribute('data-matched', String(11 + 8));
    await expect(canvas).toHaveAttribute('data-limited', String(13));
    await expect(canvas).toHaveAttribute('data-unmatched', '3');
    await expect(page.locator('#pe-debug-hud')).toContainText('글자 ');

    // 색 확인: 매칭(초록 계열)과 실패(빨강 계열) 글자 중심 픽셀
    const pixel = (cssX: number, cssY: number) =>
      canvas.evaluate(
        (c: HTMLCanvasElement, [x, y]: [number, number]) => {
          const k = c.width / c.getBoundingClientRect().width; // 비트맵 / CSS
          return Array.from(
            c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data,
          );
        },
        [cssX, cssY] as [number, number],
      );
    const matchedPx = await pixel((20 + 5) * 1.5, (20 + 7) * 1.5); // 1줄 첫 글자(매칭)
    const failedPx = await pixel((20 + 5) * 1.5, (40 + 7) * 1.5); // 2줄 첫 글자(실패)
    expect(matchedPx[1]!).toBeGreaterThan(matchedPx[0]!);
    expect(failedPx[0]!).toBeGreaterThan(failedPx[1]!);

    // 호버: 매칭 글자 → 연산 정보
    const g = await geo(page);
    const hoverMatched = charAt(g, 0, 2);
    await page.mouse.move(hoverMatched.x, hoverMatched.y);
    const tip = page.locator('#pe-debug-tip');
    await expect(tip).toContainText('연산 #0 Tj (text-show)');
    await expect(tip).toContainText('Contents[0] obj 8');
    await expect(tip).toContainText('범위 100–110');
    await expect(tip).toContainText('제한: 없음');
    // 편집 제한 글자
    const hoverLimited = charAt(g, 1, 8);
    await page.mouse.move(hoverLimited.x, hoverLimited.y);
    await expect(tip).toContainText('연산 #1');
    await expect(tip).toContainText('제한: spans-stream-boundary');
    // 매칭 실패 글자
    const hoverFailed = charAt(g, 1, 1);
    await page.mouse.move(hoverFailed.x, hoverFailed.y);
    await expect(tip).toContainText('원본 연결: 실패');
    // 글자 밖으로 나가면 툴팁이 사라진다
    await page.mouse.move(g.x + 5, g.y + 5);
    await expect(tip).toHaveCount(0);
    // 텍스트 선택은 디버그 중에도 동작한다
    await page.mouse.move(hoverLimited.x, hoverLimited.y);
    await page.screenshot({ path: testInfo.outputPath('debug-overlay.png') });
    await drag(page, charAt(g, 0, 0, 0.2), charAt(g, 0, 4, 0.8));
    expect(await copied(page)).toBe('Hello');
    // 끄면 오버레이가 사라진다
    await page.locator('#pe-debug-toggle').click();
    await expect(canvas).toHaveCount(0);
  });

  test('조밀한 페이지(11,000자): 텍스트 층 준비·전체 선택 복사·드래그 선택이 허용 시간 안에 끝난다', async ({
    page,
  }, testInfo) => {
    // 5×6pt 글자 100자 × 110줄. 실제 문서의 조밀한 페이지(소형 활자)보다 많은 글자 수다.
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

  test('M1 미구현: 텍스트·검색·디버그만 비활성화되고 렌더·페이지 이동은 유지된다', async ({
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
    await expect(page.locator('#pe-debug-toggle')).toBeDisabled();
    const events = () => page.evaluate(() => ((window as Win).__log ?? []).map((l) => l.event));
    expect((await events()).filter((e) => e === 'extract-unavailable')).toHaveLength(1);

    // 페이지 이동은 계속 동작, 같은 로그를 반복하지 않는다.
    await page.locator('#pe-next').click();
    await expect(page.locator('body')).toHaveAttribute('data-painted', '1');
    await expect(page.locator('#pe-page-input')).toHaveValue('2');
    expect((await events()).filter((e) => e === 'extract-unavailable')).toHaveLength(1);

    // 첫 Ctrl+F 는 검색창을 열지만 검색은 "사용할 수 없음"으로 끝나고,
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('a');
    await expect(page.locator('#pe-find-count')).toContainText('검색을 사용할 수 없습니다');
    expect(await events()).toContain('search-unavailable');
    await page.locator('#pe-find-input').press('Escape');
    // 이후 Ctrl+F 는 가로채지 않는다(브라우저 기본 찾기에 맡김).
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

  test('linkPage 만 미구현이면 디버그만 비활성화되고 텍스트 선택은 유지된다', async ({ page }) => {
    await openHarness(page, baseConfig({ failures: { link: 'M1 미구현: pdf-ops linkPage' } }));
    await expect(page.locator('#pe-text-layer')).toHaveCount(1);
    await page.locator('#pe-debug-toggle').click();
    await expect(page.locator('#pe-notice')).toContainText('연결 디버그');
    await expect(page.locator('#pe-debug-toggle')).toBeDisabled();
    await expect(page.locator('#pe-debug-canvas')).toHaveCount(0);
    await page.keyboard.press('Control+A');
    expect(await copied(page)).toBe(FULL_TEXT);
  });
});

// ══ 2. 확장 연동 ═════════════════════════════════════════════════════

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

/** 추출 결과가 정해질 때까지 기다린다: 텍스트 층이 생겼는지, "미구현"으로 비활성화됐는지. */
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

// ── 통합 시나리오(2026-10-19 m1 통합 후 활성화) ──────────────────────────────
// 실제 core extractPage·searchText 와 pdf-ops linkPage·getSourceMap 을 쓴다.
// 기준 문서: m0-sample.pdf(영문, 1쪽), m0-spike-saved.pdf(한글 포함).

/** pdftotext 로 확인한 m0-sample.pdf 본문(줄바꿈·공백 차이는 비교 전에 접는다). */
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

/** 줄 span 들의 텍스트(DOM 읽기 순서). */
async function textLines(page: Page): Promise<string[]> {
  return page
    .locator('#pe-text-layer .pe-line')
    .evaluateAll((lines) => lines.map((l) => l.textContent ?? ''));
}

test(`[통합] 파일 선택으로 두 번째 문서를 열면 이전 뷰어를 열기 전에 정리하고 새 문서를 그린다`, async () => {
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
    // 뷰어 DOM 은 하나만 남는다.
    await expect(page.locator('#pe-text-layer')).toHaveCount(1);
    const log = await diagOf(page.mainFrame());
    const events = log.map((e) => e.event);
    const secondOpen = events.lastIndexOf('open');
    expect(events.indexOf('viewer-unmount')).toBeGreaterThan(events.indexOf('open'));
    expect(events.indexOf('viewer-unmount')).toBeLessThan(secondOpen);
    expect(events.filter((e) => /error/.test(e))).toEqual([]);
  });
});

test(`[통합] 선택→복사: Ctrl+A 복사 결과가 m0-sample.pdf 추출 텍스트와 일치한다`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await installCopyCapture(page);
    await page.keyboard.press('Control+A');
    expect(fold(await copied(page))).toBe(M0_SAMPLE_TEXT);
  });
});

test(`[통합] 선택→복사: 드래그로 첫 두 줄을 선택하면 DOM 줄 순서대로 복사된다`, async () => {
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
    // 끝점은 둘째 줄 끝 바깥(마지막 글자 포함). 줄 구분자는 계약 4절 읽기 텍스트 규칙:
    // 같은 블록이면 "\n", 다른 블록이면 "\n\n"(m0-sample 은 제목과 본문이 다른 블록).
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

test(`[통합] 선택→복사: MIME handler 최상위(열자마자 단축키)·임베디드(클릭 후) 문맥에서도 같은 복사 결과`, async () => {
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
    // 최상위: 열자마자 뷰어가 포커스를 가져오므로 클릭 없이 단축키가 뷰어로 간다.
    await top.keyboard.press('Control+A');
    await top.keyboard.press('Control+C');
    await expect
      .poll(async () => fold(await frame.evaluate(() => (window as Win).__copied ?? null)))
      .toBe(M0_SAMPLE_TEXT);

    // 임베디드(embed·iframe·object): 바깥 페이지 포커스를 빼앗지 않고, 텍스트를 클릭하면 단축키가 뷰어로 간다.
    // 요소마다 새 페이지에서 확인한다(한 페이지의 여러 뷰어 사이 포커스 이동은 헤드리스에서 불안정해 범위 밖).
    // frames() 순서는 iframe(0)·embed(1)·object(2)다. object 는 헤드리스 Chromium 156 에서 클릭 포커스가
    // 간헐적으로 실패해(2026-10-19 실측 8회 중 3회) 자동 검증에서 빼고 Windows Chrome 수동 확인으로 둔다.
    for (const index of [0, 1]) {
      const host = await env.context.newPage();
      await host.goto(`${env.base}/embed-test.html`);
      await expect
        .poll(() => host.frames().filter((f) => f.url().startsWith(prefix)).length)
        .toBe(3);
      const f = host.frames().filter((x) => x.url().startsWith(prefix))[index]!;
      const tag = `embedded#${index}`;
      // 렌더 완료와 텍스트 층 생성을 기다린 뒤 짧게 안정화한다(렌더 마무리 중 클릭은 놓칠 수 있다).
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
      // 글자 span 은 투명하므로 force. 클릭이 그 뷰어에 포커스를 줬는지 확인한 뒤 단축키를 보낸다.
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

test(`[통합] Ctrl+F: 'paragraph' 5건, 하이라이트가 글자 위치와 일치하고 Enter 로 순환한다`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('paragraph');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 5');
    const highlights = page.locator('#pe-highlights .pe-hl');
    await expect(highlights).toHaveCount(5);

    // 하이라이트 상자 안에 중심이 드는 텍스트 층 글자를 모으면 검색어와 같아야 한다.
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

test(`[통합] Ctrl+F: 한글 검색어(m0-spike-saved.pdf '검색과 복사' 1건)`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-spike-saved.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await page.keyboard.press('Control+F');
    await page.locator('#pe-find-input').fill('검색과 복사');
    await expect(page.locator('#pe-find-count')).toHaveText('1 / 1');
    await expect(page.locator('#pe-highlights .pe-hl')).toHaveCount(1);
  });
});

test(`[통합] 디버그 오버레이: 글자 quad 색 구분과 마우스 위치 글자의 SourceOp 표시`, async () => {
  await withExtension(async (env) => {
    const page = await openViewer(env, 'm0-sample.pdf');
    expect(await extractOutcome(page)).toBe('text-layer');
    await page.locator('#pe-debug-toggle').click();
    const canvas = page.locator('#pe-debug-canvas');
    await expect(canvas).toHaveCount(1);
    const counts = await canvas.evaluate((c) => ({
      matched: Number(c.getAttribute('data-matched')),
      limited: Number(c.getAttribute('data-limited')),
      unmatched: Number(c.getAttribute('data-unmatched')),
    }));
    // 합성 문서(m0-sample)는 단순 Tj 콘텐츠이므로 매칭 실패가 없어야 한다(실측 후 기준을 조정한다).
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
