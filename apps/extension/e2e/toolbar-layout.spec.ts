/**
 * 뷰어 툴바·문서 영역 배치(M5 S3, 머리 영역 확대 보정 사용자 요청 2026-10-22).
 *
 * - 툴바는 항상 창 맨 위에 창 폭 그대로 보이고, 문서 영역(#page-container)만 가로·세로로 스크롤한다.
 * - 브라우저 확대·축소는 실제 탭 배율(`chrome.tabs.setZoom`, Ctrl +/−·Ctrl+휠·메뉴와 같은 HostZoomMap 경로)로 건다.
 *   머리 영역(툴바·알림 줄·검색창)의 화면상 크기(getBoundingClientRect × devicePixelRatio)·배치는 100% 와 같고, 문서는
 *   지금처럼 확대·축소된다.
 * - 좁은 배치(글자·여백 축소, 개발 전용 메뉴 항목 숨김, 상태 줄 자기 줄)는 창이 실제로 좁을 때(100% 환산 600px 이하)만 켜진다.
 * - 임베디드 문맥(embed·iframe·object)은 보정하지 않는다(바깥 페이지 확대를 따른다).
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

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

let context: BrowserContext;
let sw: Worker;
let server: Server;
let base: string;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  // dist/diag 를 http 로 제공한다(`/sample.pdf` 는 m0-sample.pdf, 임베디드 문맥은 embed-test.html).
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
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterEach(async () => {
  // 탭 배율은 출처 단위로 남으므로(확장 출처·시험 서버 출처) 페이지를 닫기 전에 되돌린다. 시험 안에서는 페이지를 닫지 않는다.
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

/** 뷰어가 있는 탭 id(확장 페이지 탭은 getCurrent, MIME handler 는 StreamInfo). */
async function tabIdOf(frame: Frame): Promise<number> {
  return frame.evaluate(async () => {
    const info = await chrome.mimeHandler?.getStreamInfo().catch(() => null);
    return info?.tabId ?? (await chrome.tabs.getCurrent())!.id!;
  });
}

/** 탭 배율을 바꾼다(브라우저 확대·축소와 같은 경로). */
async function setTabZoom(tabId: number, factor: number): Promise<void> {
  await sw.evaluate(([id, f]) => chrome.tabs.setZoom(id, f), [tabId, factor] as const);
}

/** 보정 문맥: 프레임이 새 배율로 바뀌고(dpr) 머리 영역 보정이 그 배율을 반영할 때까지. */
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
    // 창보다 큰 문서를 흉내 낸다(가로·세로 모두 스크롤되게).
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

/** 머리 영역의 화면상(물리 px) 상자: 툴바와 그 안의 보이는 컨트롤, 알림 줄, 검색창. */
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

/** 두 스냅숏의 물리 상자가 tol(px) 안에서 같다. */
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

test('확대 50%·200%: 머리 영역의 화면상 크기·배치는 100% 와 같고 문서는 확대·축소된다(1280px)', async () => {
  const page = await openViewer(1280, 800, false);
  const tabId = await tabIdOf(page.mainFrame());
  const base100 = await headerSnapshot(page.mainFrame());
  expect(base100.narrow).toBe(false);
  const doc100 = await pagePhysicalWidth(page);
  const docs: Record<string, number> = {};
  for (const f of [2, 0.5]) {
    await setTabZoom(tabId, f);
    await waitCompensated(page.mainFrame(), f);
    // 문서는 새 배율로 다시 그린다(창 폭 맞춤, 최대 1.5배).
    await expect.poll(() => pagePhysicalWidth(page)).not.toBeCloseTo(doc100, 0);
    docs[f] = await pagePhysicalWidth(page);
    expectSameLayout(await headerSnapshot(page.mainFrame()), base100, `확대 ${f * 100}%`);
    await expect(page.locator('html')).toHaveAttribute('data-zoom-mode', 'tabs');
  }
  expect(docs[2]!, '200%: 쪽이 커진다').toBeGreaterThan(doc100 * 1.05);
  expect(docs[0.5]!, '50%: 쪽이 작아진다').toBeLessThan(doc100 * 0.95);
  // 되돌리면 그대로다.
  await setTabZoom(tabId, 1);
  await waitCompensated(page.mainFrame(), 1);
  expectSameLayout(await headerSnapshot(page.mainFrame()), base100, '되돌림 100%');
});

test('좁은 배치는 실제 창 폭으로만 켜진다: 확대로는 켜지지 않고, 창을 줄이면 확대·축소와 무관하게 켜진다', async () => {
  const page = await openViewer(1000, 700, false);
  const frame = page.mainFrame();
  const tabId = await tabIdOf(frame);
  const wide = await headerSnapshot(frame);
  expect(wide.narrow).toBe(false);
  // 1000px 창 200%(CSS 폭 500): 좁은 배치가 아니고 100% 와 같은 배치.
  await setTabZoom(tabId, 2);
  await waitCompensated(frame, 2);
  expectSameLayout(await headerSnapshot(frame), wide, '1000px 200%');
  // 창을 400px 로 줄이면 좁은 배치(200% 그대로).
  await page.setViewportSize({ width: 400, height: 700 });
  await expect(page.locator('html')).toHaveAttribute('data-narrow', '');
  const narrow200 = await headerSnapshot(frame);
  // 400px 창 100%·50% 도 같은 좁은 배치다.
  for (const f of [1, 0.5]) {
    await setTabZoom(tabId, f);
    await waitCompensated(frame, f);
    expectSameLayout(await headerSnapshot(frame), narrow200, `400px ${f * 100}%`);
  }
  // 좁은 배치: 상태 줄은 자기 줄(툴바 안쪽 폭), 개발 전용 메뉴 항목은 숨김.
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
  // 저장 메뉴·정보 버튼과 툴바의 모든 보이는 요소가 화면 안에 있다.
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
  test(`툴바 고정·문서 영역만 스크롤: ${tag}`, async () => {
    const page = await openViewer(cfg.width, cfg.height);
    if (cfg.zoom !== 1) {
      await setTabZoom(await tabIdOf(page.mainFrame()), cfg.zoom);
      await waitCompensated(page.mainFrame(), cfg.zoom);
    }
    // 좁은 배치는 100% 환산 폭(창 폭)으로만 정해진다.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-narrow')), {
        message: `${tag}: 좁은 배치`,
      })
      .toBe(cfg.width <= 600);
    await assertToolbarPinned(page, `${tag} 초기`);

    // 문서 영역을 가로·세로로 끝까지 스크롤한 뒤에도 툴바는 그대로다.
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

    // 왼쪽 끝으로 돌아가면 첫 요소(왼쪽 화살표)가 잘리지 않는다.
    await page.evaluate(() => document.getElementById('page-container')!.scrollTo(0, 0));
    const left = await page.evaluate(() => {
      const c = document.getElementById('page-container')!.getBoundingClientRect();
      return document.getElementById('pe-arrow-prev')!.getBoundingClientRect().left - c.left;
    });
    expect(left, `${tag}: 왼쪽이 잘리지 않음`).toBeGreaterThanOrEqual(-0.5);
  });
}

test('알림 줄·검색창도 확대 보정: 화면상 크기가 100% 와 같고 검색창은 머리 영역 바로 아래', async () => {
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

test('MIME handler 최상위 문맥도 탭 배율로 보정한다', async () => {
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

test('임베디드 문맥(embed·iframe·object)은 보정하지 않고 바깥 페이지 확대를 따른다', async () => {
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
  // 뷰어 프레임은 탭 배율을 받는다(헤드리스에서는 프레임마다 반영 시점이 다르다). 받은 프레임도 머리 영역 보정은 켜지지
  // 않는다(CSS zoom 1): 화면상 크기는 바깥 확대를 따르고, 좁은 배치는 이전처럼 CSS 폭으로 정한다.
  await expect
    .poll(async () => (await Promise.all(frames.map(header))).some((s) => s.dpr === 2))
    .toBe(true);
  for (const [i, f] of frames.entries()) {
    // 화면 밖 프레임은 렌더링(resize 이벤트)이 미뤄지므로 바깥 요소를 화면 안으로 가져온 뒤 본다.
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

test('좁은 폭(400): 개발 전용 메뉴 항목 숨김, 상태 줄은 자기 줄, 쪽 이동·저장·되돌리기가 화면 안', async () => {
  const page = await openViewer(400, 700);
  await expect(page.locator('html')).toHaveAttribute('data-narrow', '');
  const { w } = await viewportSize(page);
  for (const sel of ['#pe-page-input', '#pe-doc-undo', '#pe-doc-redo', '#save-menu-button']) {
    const box = await page.locator(sel).boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box!.x + box!.width, `${sel} right`).toBeLessThanOrEqual(w + 0.5);
  }
  // 저장 메뉴는 화면 안에 열리고, 개발 전용 downloads 저장은 숨긴다.
  await page.click('#save-menu-button');
  await expect(page.locator('#save')).toBeVisible();
  await expect(page.locator('#save-as')).toBeVisible();
  await expect(page.locator('#save-downloads')).toBeHidden();
  const menu = (await page.locator('#save-menu').boundingBox()) as Box;
  expect(menu.x).toBeGreaterThanOrEqual(-0.5);
  expect(menu.x + menu.width).toBeLessThanOrEqual(w + 0.5);
  await page.keyboard.press('Escape');
  await expect(page.locator('#save-menu')).toBeHidden();
  // 툴바 높이는 여러 줄로 늘어나도 문서 영역이 남는다.
  const c = (await page.locator('#page-container').boundingBox()) as Box;
  expect(c.height).toBeGreaterThan(200);
});

test('넓은 창(1280): 쪽이 문서 영역 가운데에 놓인다', async () => {
  const page = await openViewer(1280, 800, false);
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => {
    const c = document.getElementById('page-container')!.getBoundingClientRect();
    const p = document.getElementById('pe-page')!.getBoundingClientRect();
    return Math.abs(c.left + c.width / 2 - (p.left + p.width / 2));
  });
  expect(off).toBeLessThan(20); // 화살표 칸·스크롤바 폭 차이 허용
});

for (const width of [400, 800]) {
  test(`알림 줄·검색창·정보 대화상자가 화면 안에 들어온다(${width}px)`, async () => {
    const page = await openViewer(width, 700);
    // 긴 알림을 직접 넣는다(알림 줄은 툴바 아래 고정, 검색창은 그 아래).
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

test('문맥 배지는 화면에 없고 body[data-context] 로 남는다', async () => {
  const page = await openViewer(1000, 700, false);
  await expect(page.locator('#context-badge')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-context', 'url-param');
});

test('찾기 결과 스크롤은 문서 영역(#page-container)을 움직이고 창은 스크롤하지 않는다', async () => {
  const page = await openViewer(900, 420, false);
  await expect(page.locator('#pe-text-layer .pe-line').first()).toBeAttached();
  // 쪽 아래쪽 줄에서 문서 전체에 한 번만 나오는 단어를 고른다(현재 결과가 그 자리에 오게).
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
