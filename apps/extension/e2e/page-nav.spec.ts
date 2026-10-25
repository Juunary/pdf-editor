/**
 * 쪽 좌우 이전·다음 화살표 e2e(docs/m3-viewer-ui.md 페이지 이동).
 *
 * 1) 가짜 편집 호스트 하니스: 3쪽 문서에서 앞뒤 이동·끝 쪽 비활성·툴바 연동, 편집 중 이동 시 먼저 커밋.
 * 2) 확장 연동: 시험 안에서 만든 3쪽 PDF 를 일반 뷰어·임베디드(iframe·embed)에서 열어 이동과 배치(쪽·텍스트 층을
 *    가리지 않음, 가로 넘침 없음, 좁은 폭)를 확인한다.
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

// ══ 1. 하니스 ═════════════════════════════════════════════════════════

const PARAGRAPHS = [
  { id: 1, bbox: [20, 20, 130, 60] as [number, number, number, number], text: 'Hello World' },
];

test.describe('쪽 화살표(가짜 편집 호스트, 3쪽)', () => {
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

  test('앞뒤 이동과 끝 쪽 비활성, 툴바 쪽 번호와 연동', async ({ page }) => {
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
    // 툴바 입력으로 이동해도 화살표 상태가 따라온다.
    await shownPage(page).fill('3');
    await shownPage(page).press('Enter');
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
  });

  test('화살표는 48×96 이상이고 기본·hover·비활성 모양이 구분된다(사용자 요청 2026-10-23)', async ({
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
    const disabled = await look('#pe-arrow-prev'); // 첫 쪽
    expect(disabled).not.toBe(enabled);
    // 기본 판은 88% 불투명(이전: 배경과 거의 같은 #4a4f54).
    expect(enabled).toContain('rgba(32, 33, 36, 0.88)');
    await next.hover();
    expect(await look('#pe-arrow-next')).not.toBe(enabled);
  });

  test('좌우 방향키는 쪽을 넘기지 않는다(캐럿 이동과 충돌 방지)', async ({ page }) => {
    await page.locator('#pe-page').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#pe-page')).toHaveAttribute('data-page-index', '0');
  });

  test('화살표는 쪽·텍스트 층 영역 바깥이고 쪽 가운데 클릭은 화살표가 가로채지 않는다', async ({
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

  test('편집 중 화살표를 누르면 초안을 먼저 커밋하고 이동한다', async ({ page }) => {
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
    await expect(page.locator('#pe-doc-undo')).toBeEnabled(); // 커밋된 편집이 문서 이력에 있다
  });
});

// ══ 2. 확장 연동(시험에서 만든 3쪽 PDF) ═══════════════════════════════════

/** Helvetica 한 줄씩 가진 n 쪽 PDF. */
function makePdf(n: number): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 24 Tf 72 700 Td (Page ${i + 1} navigation sample) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
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

/** 한 페이지에 뷰어 하나만 둔다(여러 뷰어 사이 포커스 이동은 헤드리스에서 불안정). */
const HOSTS: Record<string, string> = {
  iframe800: '<iframe src="/multi.pdf" style="width:800px;height:560px;border:1px solid #888">',
  iframe480: '<iframe src="/multi.pdf" style="width:480px;height:560px;border:1px solid #888">',
  embed: '<embed src="/multi.pdf" type="application/pdf" style="width:800px;height:560px">',
};

function servePdf(): Promise<{ server: Server; base: string }> {
  const pdf = makePdf(3);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/multi.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
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

/** 화살표 두 상자와 쪽 캔버스 상자(문서 좌표, 스크롤과 무관하게 비교). */
async function arrowGeometry(page: Page) {
  return page.evaluate(() => {
    const c = document.getElementById('page-container')!;
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return {
      placement: c.dataset.peArrows ?? null,
      clientWidth: c.clientWidth,
      overflow: c.scrollWidth > c.clientWidth,
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

test('[통합] 창 폭 320·400·464·800 px: 화살표가 쪽 캔버스와 겹치지 않는다(좁으면 쪽 아래 줄)', async () => {
  await withExtension(async (env) => {
    const page = await env.context.newPage();
    for (const width of [320, 400, 464, 800]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(
        `chrome-extension://${env.extensionId}/viewer.html?file=${env.base}/multi.pdf`,
      );
      await waitRendered(page.mainFrame());
      const g = await arrowGeometry(page);
      const tag = `${width} px (문서 영역 ${g.clientWidth} px, ${g.placement})`;
      expect(overlaps(g.prev, g.canvas), `${tag}: 이전 화살표 × 쪽`).toBe(false);
      expect(overlaps(g.next, g.canvas), `${tag}: 다음 화살표 × 쪽`).toBe(false);
      // 판정 기준(page-nav.ts pageArrowLayout): 문서 영역 464 px 이상이면 좌우 칸.
      expect(g.placement, tag).toBe(g.clientWidth >= 464 ? 'side' : 'below');
      if (g.placement === 'side') {
        expect(g.prev.right, tag).toBeLessThanOrEqual(g.canvas.left + 0.5);
        expect(g.next.left, tag).toBeGreaterThanOrEqual(g.canvas.right - 0.5);
        expect(g.overflow, `${tag}: 가로 넘침 없음`).toBe(false);
      } else {
        // 쪽 아래 줄, 이전이 왼쪽. 칸 몫을 빼지 않아 쪽 폭 = 문서 영역 − 여백(최소 320).
        expect(g.prev.top, tag).toBeGreaterThanOrEqual(g.canvas.bottom - 0.5);
        expect(g.next.top, tag).toBeGreaterThanOrEqual(g.canvas.bottom - 0.5);
        expect(g.prev.right, tag).toBeLessThanOrEqual(g.next.left + 0.5);
        const pageWidth = g.canvas.right - g.canvas.left;
        expect(Math.abs(pageWidth - Math.max(320, g.clientWidth - 32)), tag).toBeLessThan(1.5);
        expect(g.overflow, `${tag}: 최소 폭 때문에만 넘침`).toBe(g.clientWidth - 32 < 320);
      }
      // 끝까지 스크롤해도(가로·세로) 겹치지 않는다.
      await page.evaluate(() => {
        const c = document.getElementById('page-container')!;
        c.scrollLeft = c.scrollWidth;
        c.scrollTop = c.scrollHeight;
      });
      const end = await arrowGeometry(page);
      expect(overlaps(end.prev, end.canvas), `${tag}: 스크롤 뒤 이전`).toBe(false);
      expect(overlaps(end.next, end.canvas), `${tag}: 스크롤 뒤 다음`).toBe(false);
      if (width === 400) await navigateAndCheck(page.mainFrame());
    }
  });
});

test('[통합] 일반 뷰어: 3쪽 PDF 를 화살표로 앞뒤 이동한다', async () => {
  await withExtension(async (env) => {
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/viewer.html?file=${env.base}/multi.pdf`);
    await waitRendered(page.mainFrame());
    await expect(page.locator('#pe-page-count')).toHaveText('/ 3');
    await navigateAndCheck(page.mainFrame());
  });
});

test('[통합] 임베디드(iframe 800·480 폭, embed): 화살표가 보이고 쪽·텍스트 선택을 가리지 않는다', async () => {
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
      // 텍스트 선택·복사가 그대로 된다(글자 클릭으로 포커스를 준 뒤 Ctrl+A, Ctrl+C).
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
