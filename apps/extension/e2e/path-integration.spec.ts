/**
 * M4 통합 e2e(실제 core 패스 RPC·pdf-ops 쓰기, docs/m4-viewer-ui.md 4절 목록, docs/m4-integration.md).
 * 가짜 호스트 시험(`path-ui.spec.ts`)과 같은 DOM 식별자(`#pe-path-*`)와 `?e2e` 이음매(`window.__pe`)를 쓴다.
 * 문서는 시험에서 만드는 1쪽 PDF(채움 사각형 + 선 + 글자 한 줄)다.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseSave } from './toolbar-helpers.js';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

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
      locale: E2E_LOCALE,
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
    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __pe: { controller: { getState(): { edit: { editability: { status: string } } } } };
          }
        ).__pe.controller.getState().edit.editability.status === 'ready',
    );
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

  /**
   * Alt+클릭으로 패스를 고른다. 열린 직후에는 쪽 판정·패스 모델이 다시 불러와지며 첫 클릭이 선택 없이 끝날 수 있어
   * (모델 갱신과 겹침) 선택 상자가 보일 때까지 다시 누른다.
   *
   * 편집 커밋 직후 재판정(settling) 동안의 클릭은 뷰어가 보류했다가 판정 뒤 처리하고 이전 선택 상자는 숨기므로
   * (M5 리뷰 M8) 재판정이 끝나기를 따로 기다리지 않는다.
   */
  async function altSelect(page: Page, x: number, y: number) {
    await expect(async () => {
      const p = await at(page, x, y);
      await page.keyboard.down('Alt');
      await page.mouse.click(p.x, p.y);
      await page.keyboard.up('Alt');
      await expect(page.locator('#pe-path-box')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  }

  const pathState = (page: Page) =>
    page.evaluate(() => {
      const s = (
        window as unknown as {
          __pe: {
            controller: {
              getState(): {
                edit: { path: { settling: boolean; selection: { paintSeqs: number[] } | null } };
              };
            };
          };
        }
      ).__pe.controller.getState().edit.path;
      return { settling: s.settling, seqs: s.selection?.paintSeqs ?? null };
    });

  async function selectFill(page: Page) {
    await altSelect(page, 200, 142); // 채움 사각형(페이지 공간 y 는 위에서부터: 792−650)
    await expect(page.locator('#pe-path-fill')).toBeEnabled();
  }

  async function save(page: Page): Promise<string> {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      chooseSave(page, 'save-downloads'),
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
    await altSelect(page, 200, 292); // 선(792−500)
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

  test('커밋 직후 재판정 중의 Alt+클릭은 한 번으로 판정 뒤 반영되고, 그동안 이전 선택 상자는 숨긴다(M5 리뷰 M8)', async () => {
    const page = await open(sample);
    await altSelect(page, 200, 292); // 선
    await expect(page.locator('#pe-path-width')).toBeEnabled();
    const lineSeqs = (await pathState(page)).seqs;
    // 커밋 뒤 쪽 판정을 400 ms 늦춰 재판정 구간을 넓힌다(실제는 약 100 ms).
    await page.evaluate(() => {
      const pdf = (window as unknown as PeWindow).__pe.pdf;
      const real = pdf.getPageEditability!.bind(pdf);
      pdf.getPageEditability = async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, 400));
        return real(...args);
      };
    });
    const width = page.locator('#pe-path-width');
    await width.fill('5');
    await width.dispatchEvent('change');
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    expect((await pathState(page)).settling).toBe(true);
    await expect(page.locator('#pe-path-box')).toHaveCount(0);
    // 다시 누르지 않는다: 이 한 번이 판정 뒤 채움 사각형 선택으로 반영되어야 한다.
    const p = await at(page, 200, 142);
    await page.keyboard.down('Alt');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Alt');
    await expect(page.locator('#pe-path-fill')).toBeEnabled({ timeout: 10_000 });
    await expect(page.locator('#pe-path-box')).toBeVisible();
    const after = await pathState(page);
    expect(after.settling).toBe(false);
    expect(after.seqs).toHaveLength(1);
    expect(after.seqs).not.toEqual(lineSeqs);
    await page.close();
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
    const canvas = () =>
      page.evaluate(() =>
        (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
      );
    const setFill = async (color: string) => {
      await selectFill(page);
      await page.evaluate((value) => {
        const el = document.getElementById('pe-path-fill') as HTMLInputElement;
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, color);
    };
    await setFill('#0000ff');
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    await expect
      .poll(async () => (await paths(page)).find((p) => p.op === 'fill')!.rgb)
      .toEqual([0, 0, 1]);
    const afterFirst = await canvas();
    await setFill('#00ff00');
    await expect.poll(canvas).not.toBe(afterFirst);
    // 다음 renderPage 가 wasm 트랩(RuntimeError)을 내도록 지금 Worker 핸들을 감싼다(M3 edit-integration 과 같은 방식).
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
    // undo 뒤 렌더가 실패 → 새 Worker 에서 남은 로그(첫 EditPathOp)를 replayEdits 로 재적용한다.
    await page.click('#pe-doc-undo');
    await expect(page.locator('#notice-bar [data-notice="recovered"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(canvas, { timeout: 30_000 }).toBe(afterFirst);
    expect((await paths(page)).find((p) => p.op === 'fill')!.rgb).toEqual([0, 0, 1]);
  });
});
