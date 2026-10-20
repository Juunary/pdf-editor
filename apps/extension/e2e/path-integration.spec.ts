/**
 * M4 통합 e2e(실제 core 패스 RPC 필요). core `planPathEdit` 등이 아직 "M4 미구현" 이라 전부 `test.skip` 이다.
 * 통합 때 `test.describe` 안의 `test.skip(true, INTEGRATION_SKIP)` 한 줄을 지우면 켜진다(docs/m4-viewer-ui.md 4절 목록).
 * 본문은 가짜 호스트 시험(`path-ui.spec.ts`)과 같은 DOM 식별자(`#pe-path-*`)와 `?e2e` 이음매(`window.__pe`)를 쓰며,
 * 통합 전에는 실행한 적이 없다. 문서는 시험에서 만드는 1쪽 PDF(채움 사각형 + 선)다.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const INTEGRATION_SKIP = 'M4 core 패스 RPC(planPathEdit·beginPathEdit·…) 미구현: 통합 때 켠다';

/** 채움 사각형(100,600,200×100) + 선(100,500→300,500) + 글자 한 줄이 있는 1쪽 PDF. */
function vectorPdf(): Buffer {
  const content =
    '1 0 0 rg 100 600 200 100 re f\n0 0 1 RG 2 w 100 500 m 300 500 l S\n' +
    'BT /F1 14 Tf 100 750 Td (Vector sample) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

interface PeWindow {
  __pe: {
    pdf: Record<string, (...args: unknown[]) => Promise<unknown>>;
    controller: { getState(): { edit: { path: { selection: { paintSeqs: number[] } | null } } } };
  };
}

interface PathSummary {
  op: string;
  bbox: number[];
  color: { rgb: number[] | null } | null;
  lineWidth: number | null;
}

test.describe('통합(실제 core 패스 RPC 필요)', () => {
  // 통합 때 이 한 줄을 지운다(그룹 전체를 건너뛴다. 확장을 띄우지도 않는다).
  test.skip(true, INTEGRATION_SKIP);

  let context: BrowserContext;
  let userDataDir: string;
  let extensionId: string;
  let sample: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-path-'));
    sample = join(userDataDir, 'vector.pdf');
    writeFileSync(sample, vectorPdf());
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  async function open(file: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
    await page.waitForFunction(() => '__pe' in window);
    await page.setInputFiles('#open-file', file);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 30_000,
    });
    await expect(page.locator('#pe-notice', { hasText: '벡터 편집' })).toHaveCount(0);
    return page;
  }

  const paths = (page: Page) =>
    page.evaluate(async () => {
      const m = (await (window as unknown as PeWindow).__pe.pdf.extractPage!({
        pageIndex: 0,
        includePathSegments: true,
      })) as { paths: PathSummary[] };
      return m.paths.map((p) => ({
        op: p.op,
        bbox: p.bbox,
        rgb: p.color?.rgb ?? null,
        w: p.lineWidth,
      }));
    });

  /** 화면 좌표(페이지 공간 pt → 화면). */
  const at = (page: Page, x: number, y: number) =>
    page.evaluate(
      ([px, py]) => {
        const box = document.getElementById('pe-page')!.getBoundingClientRect();
        const s = Number(document.getElementById('pe-page')!.dataset.cssScale);
        return { x: box.left + px! * s, y: box.top + py! * s };
      },
      [x, y] as const,
    );

  async function selectFill(page: Page) {
    const p = await at(page, 200, 142); // 채움 사각형(페이지 공간 y 는 위에서부터: 792−650)
    await page.keyboard.down('Alt');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Alt');
    await expect(page.locator('#pe-path-box')).toBeVisible();
    await expect(page.locator('#pe-path-fill')).toBeEnabled();
  }

  async function save(page: Page): Promise<string> {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#save-downloads'),
    ]);
    return download.path();
  }

  test('DoD: 채움 색 변경 → 저장 → 재열기: 색만 바뀌고 글자·다른 패스는 그대로', async () => {
    const page = await open(sample);
    const before = await paths(page);
    await selectFill(page);
    await page.evaluate(() => {
      const el = document.getElementById('pe-path-fill') as HTMLInputElement;
      el.value = '#00ff00';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    const reopened = await open(await save(page));
    const after = await paths(reopened);
    expect(after).toHaveLength(before.length);
    const fill = after.find((p) => p.op === 'fill')!;
    expect(fill.rgb).toEqual([0, 1, 0]);
    expect(after.find((p) => p.op === 'stroke')).toEqual(before.find((p) => p.op === 'stroke'));
    expect(readFileSync(await save(reopened)).byteLength).toBeGreaterThan(0);
  });

  test('이동 끌기 → 저장 → 재열기: 상자가 끌어 놓은 만큼 이동', async () => {
    const page = await open(sample);
    const before = (await paths(page)).find((p) => p.op === 'fill')!;
    await selectFill(page);
    const box = (await page.locator('#pe-path-box').boundingBox())!;
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 30, sy + 15, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    const reopened = await open(await save(page));
    const after = (await paths(reopened)).find((p) => p.op === 'fill')!;
    expect(after.bbox[0]! - before.bbox[0]!).toBeGreaterThan(5);
    expect(after.bbox[2]! - after.bbox[0]!).toBeCloseTo(before.bbox[2]! - before.bbox[0]!, 1);
  });

  test('점 편집·삭제·선 두께 후 저장 → 재열기', async () => {
    const page = await open(sample);
    const line = await at(page, 200, 292); // 선(792−500)
    await page.keyboard.down('Alt');
    await page.mouse.click(line.x, line.y);
    await page.keyboard.up('Alt');
    const width = page.locator('#pe-path-width');
    await width.fill('6');
    await width.dispatchEvent('change');
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    await selectFill(page);
    await page.click('#pe-path-delete');
    const reopened = await open(await save(page));
    const after = await paths(reopened);
    expect(after.some((p) => p.op === 'fill')).toBe(false);
    expect(after.find((p) => p.op === 'stroke')!.w).toBeCloseTo(6, 3);
  });

  test('패스 끌기 반응 시간(V5): 갱신 → 영역 합성 p95 ≤ 100 ms(잠정)', async () => {
    const page = await open(sample);
    await selectFill(page);
    const box = (await page.locator('#pe-path-box').boundingBox())!;
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    const times: number[] = [];
    for (let i = 1; i <= 50; i++) {
      const t0 = Date.now();
      await page.mouse.move(sx + i, sy + i / 2);
      await page.waitForTimeout(220); // 200 ms 정지 뒤 갱신
      times.push(Date.now() - t0 - 220);
    }
    await page.mouse.up();
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({ samples: times.length, p95: times[Math.floor(times.length * 0.95)] }),
    );
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThanOrEqual(100);
  });

  test('Worker 치명 오류 → 복구 → EditPathOp 재적용 결과 = 복구 전 화면', async () => {
    const page = await open(sample);
    await selectFill(page);
    await page.evaluate(() => {
      const el = document.getElementById('pe-path-fill') as HTMLInputElement;
      el.value = '#0000ff';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    const canvas = () =>
      page.evaluate(() =>
        (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
      );
    const before = await canvas();
    await page.evaluate(() => {
      const handle = (window as unknown as { __pe: { pdf: { current: { api: unknown } } } }).__pe
        .pdf.current;
      const real = handle.api as Record<string, (...a: unknown[]) => Promise<unknown>>;
      let armed = true;
      handle.api = new Proxy(
        {},
        {
          get:
            (_t, name: string) =>
            (...args: unknown[]) => {
              if (armed && name === 'renderPage') {
                armed = false;
                const e = new Error('memory access out of bounds');
                e.name = 'RuntimeError';
                return Promise.reject(e);
              }
              return real[name]!(...args);
            },
        },
      );
    });
    await page.click('#pe-doc-undo');
    await expect(page.locator('#notice-bar [data-notice="recovered"]')).toBeVisible({
      timeout: 30_000,
    });
    await page.click('#pe-doc-redo').catch(() => {});
    expect(await canvas()).toBe(before);
  });
});
