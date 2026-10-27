/**
 * Chrome Web Store screenshots (docs/store/assets.md sections 1 and 3): 1280×800 PNGs of the real viewer, one set per UI language.
 * Opt-in (PDF_EDITOR_STORE_SHOTS=1), it only captures and checks nothing beyond the scene being reachable.
 * Documents come from the corpus (fixtures/corpus, not in the repository; STORE_SHOTS_CORPUS_DIR overrides it) and are limited to
 * KOGL Type 1, CC BY 4.0 and US public-domain documents (fixtures/corpus/manifest.json). Pages with logos or emblems are avoided.
 * Output: apps/extension/out/store-screenshots/{ko,en}/NN-scene.png.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = process.env.PDF_EDITOR_STORE_SHOTS === '1';
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const CORPUS =
  process.env.STORE_SHOTS_CORPUS_DIR ??
  fileURLToPath(new URL('../../../fixtures/corpus', import.meta.url));
const OUT = fileURLToPath(new URL('../out/store-screenshots', import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };

type Rect = [number, number, number, number];
interface ParagraphInfo {
  bbox: Rect;
  editable: boolean;
  cell: { table: number; row: number; col: number } | null;
}
interface PathInfo {
  pathIndex: number;
  paintSeq: number;
  bbox: Rect;
  editable: boolean;
}
/** PageModel.paths entry (the fields used to pick a target). */
interface ModelPath {
  op: string;
  color: { rgb: number[] | null } | null;
}
interface Editability {
  paragraphs: ParagraphInfo[];
  paths: PathInfo[];
}
interface PeWindow {
  __pe: {
    pdf: {
      getPageEditability(pageIndex: number): Promise<Editability>;
      extractPage(req: { pageIndex: number }): Promise<{ paths: ModelPath[] }>;
    };
    controller: {
      getState(): {
        loading: boolean;
        view: { pageIndex: number } | null;
        edit: {
          editability: { status: string; pageIndex?: number };
          path: { settling: boolean; selection: { paintSeqs: number[] } | null };
        };
      };
    };
  };
}

/** Document page (1-based) used by a scene. */
interface DocPage {
  doc: string;
  page: number;
}

interface ShotSet {
  locale: string;
  /** Chromium app language (LANGUAGE): extension `_locales` follow it, not Playwright `locale` (i18n.spec.ts). */
  language: string;
  view: DocPage;
  search: DocPage & { query: string };
  /** `trim` characters are deleted from the end of the paragraph before `text` is typed, so the edit stays inside the area. */
  paragraph: DocPage & { trim: number; text: string; pick: (p: ParagraphInfo[]) => ParagraphInfo };
  cell: DocPage & { text: string; pick: (p: ParagraphInfo[]) => ParagraphInfo };
  path: DocPage & { fill: string };
  marks: DocPage & { pick: (p: ParagraphInfo[]) => ParagraphInfo };
  save: DocPage & {
    trim: number;
    text: string;
    fileName: string;
    pick: (p: ParagraphInfo[]) => ParagraphInfo;
  };
}

const area = (b: Rect) => (b[2] - b[0]) * (b[3] - b[1]);
const largestBody = (ps: ParagraphInfo[]) =>
  ps.filter((p) => p.editable && !p.cell).sort((a, b) => area(b.bbox) - area(a.bbox))[0]!;
/**
 * Chart bars: editable non-white fills, taller than 20 pt and narrower than 60 pt, centred between 25% and 70% of the page width
 * (a bar at the page edge squeezes the path panel); coloured bars first, then the largest.
 */
const chartBars = (ps: PathInfo[], model: ModelPath[]) => {
  const rgb = (p: PathInfo) => model[p.pathIndex]?.color?.rgb ?? null;
  const chroma = (c: number[]) => Math.max(...c) - Math.min(...c);
  const width = Math.max(...ps.map((p) => p.bbox[2]));
  const cx = (p: PathInfo) => (p.bbox[0] + p.bbox[2]) / 2 / width;
  return ps
    .filter((p) => p.editable && model[p.pathIndex]?.op === 'fill')
    .filter((p) => rgb(p) && Math.min(...rgb(p)!) < 0.95)
    .filter((p) => p.bbox[3] - p.bbox[1] > 20 && p.bbox[2] - p.bbox[0] < 60)
    .filter((p) => cx(p) > 0.25 && cx(p) < 0.7)
    .sort(
      (a, b) =>
        Number(chroma(rgb(b)!) > 0.2) - Number(chroma(rgb(a)!) > 0.2) ||
        area(b.bbox) - area(a.bbox),
    )
    .slice(0, 5);
};
const middleCell = (col: (cols: number) => number) => (ps: ParagraphInfo[]) => {
  const cells = ps.filter((p) => p.editable && p.cell);
  const cols = Math.max(...cells.map((p) => p.cell!.col)) + 1;
  const rows = Math.max(...cells.map((p) => p.cell!.row)) + 1;
  const want = { col: col(cols), row: Math.floor(rows / 2) };
  return cells.sort(
    (a, b) =>
      Math.abs(a.cell!.row - want.row) +
      Math.abs(a.cell!.col - want.col) -
      (Math.abs(b.cell!.row - want.row) + Math.abs(b.cell!.col - want.col)),
  )[0]!;
};
const firstRestricted = (ps: ParagraphInfo[]) => ps.find((p) => !p.editable && p.cell)!;

const SETS: Record<'ko' | 'en', ShotSet> = {
  ko: {
    locale: 'ko-KR',
    language: 'ko',
    view: { doc: 'kogl-mods-cpi-202609', page: 5 },
    search: { doc: 'kogl-mods-cpi-202609', page: 12, query: '상승' },
    paragraph: {
      doc: 'kogl-nabo-rnd107',
      page: 23,
      trim: 6,
      text: '보여 주었다.',
      pick: largestBody,
    },
    cell: { doc: 'kogl-nabo-rnd107', page: 30, text: '보건 의료', pick: middleCell(() => 0) },
    path: { doc: 'kogl-mods-cpi-202609', page: 9, fill: '#e8590c' },
    marks: { doc: 'kogl-mods-cpi-202609', page: 12, pick: firstRestricted },
    save: {
      doc: 'kogl-nabo-rnd107',
      page: 23,
      trim: 6,
      text: '강조하였다.',
      fileName: '정부-RnD-파급효과-편집.pdf',
      pick: largestBody,
    },
  },
  en: {
    locale: 'en-US',
    language: 'en',
    view: { doc: 'nist-ai-100-1', page: 6 },
    search: { doc: 'nist-ai-100-1', page: 6, query: 'risk' },
    paragraph: {
      doc: 'nist-ai-100-1',
      page: 6,
      trim: 0,
      text: ' Edited in place.',
      pick: largestBody,
    },
    cell: { doc: 'nist-cswp29', page: 20, text: 'Risk Strategy', pick: middleCell(() => 1) },
    path: { doc: 'ustreas-mts-202509', page: 6, fill: '#e8590c' },
    marks: { doc: 'ustreas-mts-202509', page: 6, pick: (ps) => ps.find((p) => !p.editable)! },
    save: {
      doc: 'nist-ai-100-1',
      page: 6,
      trim: 0,
      text: ' Saved with this edit.',
      fileName: 'ai-rmf-edited.pdf',
      pick: largestBody,
    },
  },
};

for (const [lang, set] of Object.entries(SETS)) {
  test.describe(`store screenshots (${lang})`, () => {
    test.skip(!RUN, 'Skipped unless PDF_EDITOR_STORE_SHOTS=1');
    test.skip(!existsSync(CORPUS), `No corpus directory: ${CORPUS}`);

    let context: BrowserContext;
    let userDataDir: string;
    let extensionId: string;
    const outDir = join(OUT, lang);

    test.beforeAll(async () => {
      mkdirSync(outDir, { recursive: true });
      userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-store-shots-'));
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        locale: set.locale,
        env: { ...process.env, LANGUAGE: set.language },
        viewport: VIEWPORT,
        args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      });
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      extensionId = new URL(sw.url()).host;
    });

    test.afterAll(async () => {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    });

    /** Opens the document and moves to the page; waits for the render and the editability classification. */
    async function open(at: DocPage, saveName?: string): Promise<Page> {
      const page = await context.newPage();
      await page.addInitScript((name) => {
        // The FSA picker cannot be shown headless: stand in a handle that accepts the bytes, so the real save path runs.
        Object.defineProperty(window, 'showSaveFilePicker', {
          configurable: true,
          value: async (o: { suggestedName: string }) => ({
            name: name ?? o.suggestedName,
            createWritable: async () => ({ write: async () => {}, close: async () => {} }),
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
          }),
        });
      }, saveName);
      await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
      await page.waitForFunction(() => '__pe' in window);
      await page.setInputFiles('#open-file', join(CORPUS, `${at.doc}.pdf`));
      await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
        timeout: 60_000,
      });
      if (at.page > 1) {
        await page.fill('#pe-page-input', String(at.page));
        await page.press('#pe-page-input', 'Enter');
      }
      await page.waitForFunction(
        (index) => {
          const s = (window as unknown as PeWindow).__pe.controller.getState();
          return (
            !s.loading &&
            s.view?.pageIndex === index &&
            s.edit.editability.status === 'ready' &&
            s.edit.editability.pageIndex === index
          );
        },
        at.page - 1,
        { timeout: 60_000 },
      );
      await page.locator('#pe-page-input').blur();
      return page;
    }

    const editability = (page: Page, at: DocPage) =>
      page.evaluate(
        (i) => (window as unknown as PeWindow).__pe.pdf.getPageEditability(i),
        at.page - 1,
      );

    /** Scrolls the page-space rectangle to about 40% of the viewport height and returns its center in screen coordinates. */
    async function reveal(page: Page, bbox: Rect): Promise<{ x: number; y: number }> {
      return page.evaluate((b) => {
        const el = document.getElementById('pe-page')!;
        let scroller: Element = document.scrollingElement!;
        for (let e = el.parentElement; e; e = e.parentElement) {
          if (
            /(auto|scroll)/.test(getComputedStyle(e).overflowY) &&
            e.scrollHeight > e.clientHeight
          ) {
            scroller = e;
            break;
          }
        }
        const s = Number(el.dataset.cssScale);
        const top = el.getBoundingClientRect().top + b[1]! * s;
        scroller.scrollTop += top - innerHeight * 0.4;
        const box = el.getBoundingClientRect();
        return { x: box.left + ((b[0]! + b[2]!) / 2) * s, y: box.top + ((b[1]! + b[3]!) / 2) * s };
      }, bbox);
    }

    const settled = (page: Page) =>
      page.waitForFunction(
        () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
      );

    async function typeAtEnd(page: Page, at: { x: number; y: number }, trim: number, text: string) {
      await page.mouse.dblclick(at.x, at.y);
      await expect(page.locator('#pe-edit-layer')).toBeVisible({ timeout: 20_000 });
      await settled(page);
      await page.keyboard.press('Control+End');
      for (let i = 0; i < trim; i++) await page.keyboard.press('Backspace');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.insertText', { text });
      await settled(page);
    }

    const shot = async (page: Page, name: string) => {
      await page.mouse.move(0, VIEWPORT.height - 1);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, name) });
    };

    test('01 viewer', async () => {
      const page = await open(set.view);
      await shot(page, '01-viewer.png');
    });

    test('02 search', async () => {
      const page = await open(set.search);
      await page.keyboard.press('Control+f');
      await page.locator('#pe-find-input').fill(set.search.query);
      await page.keyboard.press('Enter');
      await expect(page.locator('#pe-find-count')).toContainText(/\d/, { timeout: 30_000 });
      await expect(page.locator('#pe-highlights > *').first()).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(outDir, '02-search.png') });
    });

    test('03 paragraph edit', async () => {
      const page = await open(set.paragraph);
      const target = set.paragraph.pick((await editability(page, set.paragraph)).paragraphs);
      await typeAtEnd(
        page,
        await reveal(page, target.bbox),
        set.paragraph.trim,
        set.paragraph.text,
      );
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, '03-paragraph-edit.png') });
    });

    test('04 table cell edit', async () => {
      const page = await open(set.cell);
      const target = set.cell.pick((await editability(page, set.cell)).paragraphs);
      const at = await reveal(page, target.bbox);
      await page.mouse.dblclick(at.x, at.y);
      await expect(page.locator('#pe-edit-layer')).toBeVisible({ timeout: 20_000 });
      await settled(page);
      await page.keyboard.press('Control+a');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.insertText', { text: set.cell.text });
      await settled(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, '04-table-cell-edit.png') });
    });

    test('05 vector path edit', async () => {
      const page = await open(set.path);
      const model = await page.evaluate(
        (i) => (window as unknown as PeWindow).__pe.pdf.extractPage({ pageIndex: i }),
        set.path.page - 1,
      );
      const selected = () =>
        page.evaluate(
          () =>
            (window as unknown as PeWindow).__pe.controller.getState().edit.path.selection
              ?.paintSeqs ?? null,
        );
      // A click at the bar center can land on a smaller path drawn over it (an axis or grid line): then try the next bar.
      let picked = false;
      for (const target of chartBars((await editability(page, set.path)).paths, model.paths)) {
        await expect(async () => {
          const at = await reveal(page, target.bbox);
          await page.keyboard.down('Alt');
          await page.mouse.click(at.x, at.y);
          await page.keyboard.up('Alt');
          await expect(page.locator('#pe-path-box')).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 20_000 });
        if ((await selected())?.join() === String(target.paintSeq)) {
          picked = true;
          break;
        }
        await page.keyboard.press('Escape');
      }
      expect(picked).toBe(true);
      await expect(page.locator('#pe-path-fill')).toBeEnabled();
      await page.evaluate((color) => {
        const el = document.getElementById('pe-path-fill') as HTMLInputElement;
        el.value = color;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, set.path.fill);
      await expect(page.locator('#pe-doc-undo')).toBeEnabled({ timeout: 20_000 });
      await page.waitForFunction(
        () => !(window as unknown as PeWindow).__pe.controller.getState().edit.path.settling,
      );
      await expect(page.locator('#pe-path-box')).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(outDir, '05-vector-path-edit.png') });
    });

    test('06 editable marks', async () => {
      const page = await open(set.marks);
      const target = set.marks.pick((await editability(page, set.marks)).paragraphs);
      await page.click('#pe-overlay-toggle');
      await expect(page.locator('#pe-marks-legend')).toBeVisible({ timeout: 20_000 });
      const at = await reveal(page, target.bbox);
      await expect(async () => {
        await page.mouse.move(at.x - 1, at.y);
        await page.mouse.move(at.x, at.y);
        await expect(page.locator('#pe-mark-tip')).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, '06-editable-marks.png') });
    });

    test('07 save', async () => {
      const page = await open(set.save, set.save.fileName);
      const target = set.save.pick((await editability(page, set.save)).paragraphs);
      await typeAtEnd(page, await reveal(page, target.bbox), set.save.trim, set.save.text);
      await page.keyboard.press('Escape');
      await expect(page.locator('#pe-edit-layer')).toHaveCount(0, { timeout: 20_000 });
      await page.click('#save-menu-button');
      await page.click('#save');
      await expect(page.locator('#status')).toContainText(set.save.fileName, { timeout: 60_000 });
      // Close the post-save notices so the saved status and the save menu are what the shot shows.
      for (const close of await page.locator('#notice-bar .notice button').all())
        await close.click();
      await page.click('#save-menu-button');
      await expect(page.locator('#save-menu')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, '07-save.png') });
    });
  });
}
