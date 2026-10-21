/**
 * 뷰어 툴바·문서 영역 배치(M5 S3): 툴바는 항상 창 맨 위에 창 폭 그대로 보이고, 문서 영역(#page-container)만 가로·세로로
 * 스크롤한다. 브라우저 확대·축소(CSS 뷰포트 축소 + dpr 증가), 좁은 창(분할 화면)에서도 저장 버튼 등이 화면 안에 있어야 한다.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');

let context: BrowserContext;
let server: Server;
let base: string;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  const pdf = readFileSync(SAMPLE);
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
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
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

/** 브라우저 확대 z 배: CSS 뷰포트는 1/z, dpr 은 z 배(Ctrl +/− 와 같은 효과). */
async function setViewport(page: Page, width: number, height: number, zoom: number) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(width / zoom),
    height: Math.round(height / zoom),
    deviceScaleFactor: zoom,
    mobile: false,
  });
}

async function openViewer(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html?file=${base}/sample.pdf`);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  // 창보다 큰 문서를 흉내 낸다(가로·세로 모두 스크롤되게).
  await page.evaluate(() => {
    const filler = document.createElement('div');
    filler.id = 'test-filler';
    filler.style.cssText = 'flex:none;width:3000px;height:3000px';
    document.getElementById('page-container')!.append(filler);
  });
  return page;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function viewportSize(page: Page) {
  return page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
}

async function assertToolbarPinned(page: Page, tag: string) {
  const { w, h } = await viewportSize(page);
  const tb = (await page.locator('#toolbar').boundingBox()) as Box;
  expect(tb.y, `${tag}: 툴바 top`).toBeCloseTo(0, 0);
  expect(tb.x, `${tag}: 툴바 left`).toBeCloseTo(0, 0);
  expect(tb.width, `${tag}: 툴바 폭 = 창 폭`).toBeCloseTo(w, 0);
  // 저장·정보 버튼과 툴바의 모든 보이는 직계 자식이 화면 안에 있다.
  for (const sel of ['#save', '#save-as', '#about']) {
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

const CONFIGS = [
  { width: 400, height: 700, zoom: 1 },
  { width: 800, height: 700, zoom: 1 },
  { width: 1280, height: 800, zoom: 1 },
  { width: 800, height: 700, zoom: 1.5 },
  { width: 1280, height: 800, zoom: 2 },
  { width: 400, height: 700, zoom: 2 },
];

for (const cfg of CONFIGS) {
  const tag = `${cfg.width}x${cfg.height} 확대 ${cfg.zoom}`;
  test(`툴바 고정·문서 영역만 스크롤: ${tag}`, async () => {
    const page = await openViewer();
    await setViewport(page, cfg.width, cfg.height, cfg.zoom);
    await page.waitForTimeout(300);
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
    await page.close();
  });
}

test('좁은 폭(400): 개발 전용 버튼·긴 글자 숨김, 상태 줄은 자기 줄, 쪽 이동·저장·되돌리기가 화면 안', async () => {
  const page = await openViewer();
  await setViewport(page, 400, 700, 1);
  await page.waitForTimeout(300);
  await expect(page.locator('#save-downloads')).toBeHidden();
  await expect(page.locator('#save-as .long')).toBeHidden();
  const { w } = await viewportSize(page);
  for (const sel of ['#pe-page-input', '#pe-doc-undo', '#pe-doc-redo', '#save']) {
    const box = await page.locator(sel).boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box!.x + box!.width, `${sel} right`).toBeLessThanOrEqual(w + 0.5);
  }
  // 툴바 높이는 여러 줄로 늘어나도 문서 영역이 남는다.
  const c = (await page.locator('#page-container').boundingBox()) as Box;
  expect(c.height).toBeGreaterThan(200);
  await page.close();
});

test('넓은 창(1280): 쪽이 문서 영역 가운데에 놓인다', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html?file=${base}/sample.pdf`);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  await setViewport(page, 1280, 800, 1);
  await page.waitForTimeout(500);
  const off = await page.evaluate(() => {
    const c = document.getElementById('page-container')!.getBoundingClientRect();
    const p = document.getElementById('pe-page')!.getBoundingClientRect();
    return Math.abs(c.left + c.width / 2 - (p.left + p.width / 2));
  });
  expect(off).toBeLessThan(20); // 화살표 칸·스크롤바 폭 차이 허용
  await page.close();
});

for (const width of [400, 800]) {
  test(`알림 줄·검색창·정보 대화상자가 화면 안에 들어온다(${width}px)`, async () => {
    const page = await openViewer();
    await setViewport(page, width, 700, 1);
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
    await page.close();
  });
}

test('문맥 배지는 화면에 없고 body[data-context] 로 남는다', async () => {
  const page = await openViewer();
  await expect(page.locator('#context-badge')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-context', 'url-param');
  await page.close();
});

test('찾기 결과 스크롤은 문서 영역(#page-container)을 움직이고 창은 스크롤하지 않는다', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(`chrome-extension://${extensionId}/viewer.html?file=${base}/sample.pdf`);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
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
  await page.close();
});
