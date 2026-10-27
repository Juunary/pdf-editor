/**
 * Path drag response time (docs/m4-contract.md 6.2·1.1 performance, V5). Opt-in: runs only when PATH_LATENCY_CORPUS_DIR is set.
 *
 *   PATH_LATENCY_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus \
 *     pnpm --filter @pdf-editor/extension exec playwright test e2e/path-latency.spec.ts
 *
 * Page: the corpus page with the most paths (kogl-mods-cpi-202609 page 4, docs/m4-core.md 4.1). From the largest editable paths, the box centers of 10 are
 * picked via the Alt+Shift selection path (`PathController.selectAt`), then the selection box is dragged in 50 steps (30 ms between steps, idle update under 200 ms).
 * Step sample = `performance.now()` just before input -> time of the second requestAnimationFrame after input (after compositing). Includes the CDP round trip.
 * Also measures the time until commit after release (undo button enabled). Result: out/m4-path-latency/latency.json.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';

const CORPUS = process.env.PATH_LATENCY_CORPUS_DIR;
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const OUT = resolve(
  fileURLToPath(new URL('../../../out/m4-path-latency', import.meta.url)),
  process.env.PATH_LATENCY_OUT ?? 'latency.json',
);
const DOC = 'kogl-mods-cpi-202609.pdf';
const PAGE = 3;
const PATHS = 10;
const STEPS = 50;

interface PeWindow {
  __pe: {
    pdf: Record<string, (...args: unknown[]) => Promise<unknown>>;
    controller: {
      goToPageInput(text: string): boolean;
      getState(): {
        pageIndex: number;
        edit: {
          editability: { status: string; pageIndex?: number };
          path: { selection: { paintSeqs: number[]; plan: unknown } | null };
        };
      };
      edit: {
        paths: {
          selectAt(
            pageIndex: number,
            point: [number, number],
            cssScale: number,
            additive: boolean,
          ): Promise<number[]>;
        };
      };
    };
  };
}

function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? NaN };
}

test.describe('path drag response time (contract 6.2)', () => {
  test.skip(!CORPUS, 'PATH_LATENCY_CORPUS_DIR 없음(옵트인)');
  test.setTimeout(600_000);

  let context: BrowserContext;
  let userDataDir: string;
  let extensionId: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-path-latency-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      locale: E2E_LOCALE,
      viewport: { width: 1600, height: 1500 },
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('10 fixed paths × 50-step drag on the page with the most paths', async () => {
    const page: Page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
    await page.waitForFunction(() => '__pe' in window);
    await page.setInputFiles('#open-file', join(CORPUS!, DOC));
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 60_000,
    });
    await page.evaluate((n) => {
      (window as unknown as PeWindow).__pe.controller.goToPageInput(String(n + 1));
    }, PAGE);
    await page.waitForFunction(
      (n) => {
        const st = (window as unknown as PeWindow).__pe.controller.getState();
        return st.pageIndex === n && st.edit.editability.status === 'ready';
      },
      PAGE,
      { timeout: 120_000 },
    );
    const chosen = await page.evaluate(
      async ([pageIndex, count]) => {
        const pe = (window as unknown as PeWindow).__pe;
        const e = (await pe.pdf.getPageEditability!(pageIndex)) as {
          paths: { paintSeq: number; bbox: number[]; editable: boolean }[];
        };
        const area = (b: number[]) => (b[2]! - b[0]!) * (b[3]! - b[1]!);
        const picks = e.paths
          .filter((p) => p.editable)
          .sort((a, b) => area(b.bbox) - area(a.bbox))
          .slice(0, count!);
        const scale = Number(document.getElementById('pe-page')!.dataset.cssScale);
        for (const [k, p] of picks.entries()) {
          const c: [number, number] = [
            (p.bbox[0]! + p.bbox[2]!) / 2,
            (p.bbox[1]! + p.bbox[3]!) / 2,
          ];
          await pe.controller.edit.paths.selectAt(pageIndex!, c, scale, k > 0);
        }
        return { picks: picks.map((p) => p.paintSeq), scale };
      },
      [PAGE, PATHS] as const,
    );
    await page.waitForFunction(
      () => {
        const sel = (window as unknown as PeWindow).__pe.controller.getState().edit.path.selection;
        return sel !== null && sel.plan !== null;
      },
      undefined,
      { timeout: 60_000 },
    );
    const selected = await page.evaluate(
      () =>
        (window as unknown as PeWindow).__pe.controller.getState().edit.path.selection!.paintSeqs,
    );
    const box = (await page.locator('#pe-path-box').boundingBox())!;
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    const now = () => page.evaluate(() => performance.now());
    const painted = () =>
      page.evaluate(
        () =>
          new Promise<number>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))),
          ),
      );
    const samples: number[] = [];
    for (let i = 1; i <= STEPS; i++) {
      const t0 = await now();
      await page.mouse.move(sx + i, sy + i / 2);
      samples.push((await painted()) - t0);
      await page.waitForTimeout(30);
    }
    const tUp = Date.now();
    await page.mouse.up();
    await expect(page.locator('#pe-doc-undo')).toBeEnabled({ timeout: 60_000 });
    const releaseMs = Date.now() - tUp;
    const result = {
      doc: DOC,
      page: PAGE + 1,
      cssScale: chosen.scale,
      picked: chosen.picks.length,
      selected: selected.length,
      steps: summarize(samples),
      releaseToCommitMs: releaseMs,
      samples,
    };
    mkdirSync(resolve(OUT, '..'), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 1));
    console.log(JSON.stringify({ ...result, samples: undefined }));
    expect(selected.length).toBeGreaterThan(0);
  });
});
