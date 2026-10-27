/**
 * M4 viewer-ui e2e (docs/m4-viewer-ui.md): cell entry, vector path selection/editing, editability overlay, table grid (merged cells), input buffer, R-L1.
 * Only the viewer-ui build output is served with the fake edit host (`packages/viewer-ui/test/fake-edit-host.ts`). The real core path RPC is
 * still "M4 not implemented", so flows that need it are left as `test.skip` in `path-integration.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import type { PageLayout, PathSegment } from '@pdf-editor/shared-types';
import {
  editModel,
  openEditHarness,
  startEditHarness,
  stopEditHarness,
  type EditHarnessConfig,
} from './edit-harness.js';
import type { FakePath } from '../../../packages/viewer-ui/test/fake-edit-host.js';
import { makePath } from '../../../packages/viewer-ui/test/path-fixtures.js';

type R = [number, number, number, number];

const CURVE: PathSegment[] = [
  { type: 'M', p: [300, 100] },
  { type: 'C', p1: [330, 50], p2: [370, 50], p3: [400, 100] },
];

/** Path composition (page-space pt). seq 11 is a smaller path inside seq 10. */
const PATHS: FakePath[] = [
  { info: makePath(10, [100, 200, 220, 260]) },
  {
    info: makePath(11, [130, 210, 160, 230], {
      color: { space: 'DeviceRGB', values: [0, 0, 1], rgb: [0, 0, 1] },
    }),
  },
  { info: makePath(12, [300, 300, 340, 320]), editable: false, reasons: ['clip-path'] },
  {
    info: makePath(13, [400, 200, 440, 200], {
      op: 'stroke',
      lineWidth: 2,
      color: { space: 'DeviceRGB', values: [0, 0, 0], rgb: [0, 0, 0] },
      segments: [
        { type: 'M', p: [400, 200] },
        { type: 'L', p: [440, 200] },
      ],
    }),
  },
  {
    info: makePath(14, [300, 50, 400, 100], {
      op: 'stroke',
      lineWidth: 1,
      color: { space: 'DeviceRGB', values: [0, 0, 0], rgb: [0, 0, 0] },
      segments: CURVE,
    }),
  },
  { info: makePath(15, [10, 10, 10.5, 12]) }, // small path: omitted from the editability overlay
];

const PARAGRAPHS = [
  { id: 1, bbox: [20, 20, 130, 60] as R, text: 'Hello World' },
  { id: 5, bbox: [20, 300, 120, 330] as R, text: '셀', cell: { table: 0, row: 0, col: 1 } },
  {
    id: 6,
    bbox: [20, 340, 120, 370] as R,
    text: '잠긴 셀',
    editable: false,
    reasons: ['vertical-or-rotated'],
    cell: { table: 0, row: 1, col: 1 },
  },
];

/** 3×3 table with merged cells: (0,0) is a 1×2 merge, (1,2) is a 2×1 merge. */
const TABLE_LAYOUT = {
  bounds: [0, 0, 612, 792],
  columns: [],
  paragraphs: [],
  figures: [],
  readingOrder: [],
  tables: [
    {
      id: 0,
      bbox: [20, 400, 320, 490],
      rows: 3,
      cols: 3,
      rowBounds: [400, 430, 460, 490],
      colBounds: [20, 120, 220, 320],
      strategy: 'lines',
      paths: [],
      cells: [
        {
          row: 0,
          col: 0,
          rowSpan: 1,
          colSpan: 2,
          bbox: [20, 400, 220, 430],
          lines: [],
          paragraphs: [],
        },
        {
          row: 0,
          col: 2,
          rowSpan: 1,
          colSpan: 1,
          bbox: [220, 400, 320, 430],
          lines: [],
          paragraphs: [],
        },
        {
          row: 1,
          col: 2,
          rowSpan: 2,
          colSpan: 1,
          bbox: [220, 430, 320, 490],
          lines: [],
          paragraphs: [],
        },
      ],
    },
  ],
} as unknown as PageLayout;

function config(extra: Partial<EditHarnessConfig> = {}): EditHarnessConfig {
  return {
    model: editModel(),
    paragraphs: PARAGRAPHS,
    paths: PATHS,
    layout2: TABLE_LAYOUT,
    cssScale: 1.5,
    ...extra,
  };
}

interface Geo {
  x: number;
  y: number;
  scale: number;
}

async function geo(page: Page): Promise<Geo> {
  const box = await page.locator('#pe-page').boundingBox();
  if (!box) throw new Error('#pe-page 없음');
  return {
    x: box.x,
    y: box.y,
    scale: Number(await page.locator('#pe-page').getAttribute('data-css-scale')),
  };
}

const at = (g: Geo, x: number, y: number) => ({ x: g.x + x * g.scale, y: g.y + y * g.scale });

interface FakeWindow {
  __edit: {
    count(m: string): number;
    pathEdits: {
      transform: number[] | null;
      fill: number[] | null;
      lineWidth: number | null;
      points: { index: number; to: number[] }[] | null;
      delete: boolean;
    }[];
    pathInfos(): {
      paintSeq: number;
      bbox: number[];
      color: { rgb: number[] } | null;
      lineWidth: number | null;
    }[];
    calls: { method: string; args: unknown[] }[];
    hold(m: string): () => void;
  };
  __controller: {
    getState(): {
      edit: {
        history: { edits: number } | null;
        session: { editor: { text: string; caret: number }; dirty: boolean } | null;
        path: { selection: { paintSeqs: number[] } | null; gesture: unknown };
      };
    };
  };
  __rel?: () => void;
}

const calls = (page: Page, m: string) =>
  page.evaluate((x) => (window as unknown as FakeWindow).__edit.count(x), m);
const pathEdits = (page: Page) =>
  page.evaluate(() => (window as unknown as FakeWindow).__edit.pathEdits);
const pathInfo = (page: Page, seq: number) =>
  page.evaluate(
    (s) =>
      (window as unknown as FakeWindow).__edit.pathInfos().find((p) => p.paintSeq === s) ?? null,
    seq,
  );
const edits = (page: Page) =>
  page.evaluate(
    () => (window as unknown as FakeWindow).__controller.getState().edit.history?.edits ?? 0,
  );
const selection = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as FakeWindow).__controller.getState().edit.path.selection?.paintSeqs ??
      [],
  );

async function altClick(
  page: Page,
  x: number,
  y: number,
  modifiers: ('Alt' | 'Shift')[] = ['Alt'],
) {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(x, y);
  for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
}

let errors: string[] = [];
test.describe('M4 cell and vector path UI (fake edit host)', () => {
  test.beforeAll(startEditHarness);
  test.afterAll(stopEditHarness);
  test.beforeEach(async ({ page }) => {
    errors = await openEditHarness(page, config());
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

  test.describe('cell entry', () => {
    test('cell box border (data-cell) over a cell, double-click edits the cell', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 70, 315);
      await page.mouse.move(p.x, p.y);
      const hover = page.locator('#pe-edit-hover');
      await expect(hover).toHaveAttribute('data-cell', '1');
      const box = await hover.boundingBox();
      expect(Math.abs(box!.width - 100 * g.scale)).toBeLessThan(0.75);
      await page.mouse.dblclick(p.x, p.y);
      await expect(page.locator('#pe-edit-layer')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    });

    test('a restricted cell shows the "이 셀은 편집할 수 없습니다" popover', async ({ page }) => {
      const g = await geo(page);
      const p = at(g, 70, 355);
      await page.mouse.dblclick(p.x, p.y);
      const pop = page.locator('#pe-edit-popover');
      await expect(pop).toContainText('이 셀은 편집할 수 없습니다');
      await expect(pop).toContainText('표 셀 안 글자입니다(테스트).');
    });
  });

  test.describe('R-L1 and input buffer', () => {
    test('beginParagraphEdit receives the render scale and sends no start-update RPC', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 60, 30);
      await page.mouse.dblclick(p.x, p.y);
      await expect(page.locator('#pe-edit-layer')).toBeVisible();
      const scale = await page.evaluate(() => {
        const c = (window as unknown as FakeWindow).__edit.calls.find(
          (x) => x.method === 'beginParagraphEdit',
        );
        return c?.args[3];
      });
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      expect(scale).toBeCloseTo(1.5 * dpr, 5);
      expect(await calls(page, 'updateParagraphDraft')).toBe(0);
    });

    test('characters typed while the editor is opening go to the caret position after it opens', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 60, 30);
      await page.evaluate(() => {
        (window as unknown as FakeWindow).__rel = (window as unknown as FakeWindow).__edit.hold(
          'beginParagraphEdit',
        );
      });
      await page.mouse.dblclick(p.x, p.y);
      await page.keyboard.type('xyz');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pe-input-buffer');
      await page.evaluate(() => (window as unknown as FakeWindow).__rel!());
      await expect(page.locator('#pe-edit-layer')).toBeVisible();
      const text = await page.evaluate(
        () => (window as unknown as FakeWindow).__controller.getState().edit.session!.editor.text,
      );
      expect(text).toContain('xyz');
      expect(text.length).toBe('Hello World'.length + 3);
      await expect(page.locator('#pe-input-buffer')).toHaveCount(0);
    });
  });

  test.describe('editability overlay', () => {
    test('off by default; toggling shows paragraph, cell and path borders and the legend, small paths omitted, pointer passes through', async ({
      page,
    }) => {
      await expect(page.locator('#pe-marks')).toHaveCount(0);
      await page.click('#pe-overlay-toggle');
      const marks = page.locator('#pe-marks');
      await expect(marks).toBeVisible();
      await expect(marks).toHaveAttribute('data-cells', '2');
      await expect(marks).toHaveAttribute('data-paragraphs', '1');
      await expect(marks).toHaveAttribute('data-paths', '5');
      await expect(page.locator('#pe-marks-legend')).toContainText('편집 가능');
      expect(await marks.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
      // Pointer pass-through: even with it on, double-click paragraph editing works as before
      const g = await geo(page);
      const p = at(g, 60, 30);
      await page.mouse.dblclick(p.x, p.y);
      await expect(page.locator('#pe-edit-layer')).toBeVisible();
      await expect(page.locator('#pe-marks')).toHaveCount(0); // the overlay is hidden while editing
    });

    test('layout and editability overlay in one button: one press turns both on together and another turns both off', async ({
      page,
    }) => {
      await expect(page.locator('#pe-mark-toggle')).toHaveCount(0);
      await expect(page.locator('#pe-layout-toggle')).toHaveCount(0);
      const btn = page.locator('#pe-overlay-toggle');
      await expect(btn).toHaveText('레이아웃·편집 표시');
      await expect(btn).toHaveAttribute('aria-pressed', 'false');
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#pe-layout-canvas')).toBeVisible();
      await expect(page.locator('#pe-marks')).toBeVisible();
      expect(await btn.getAttribute('title')).toContain('클릭으로 패스를 선택');
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#pe-layout-canvas')).toHaveCount(0);
      await expect(page.locator('#pe-marks')).toHaveCount(0);
      // When off, click selection of paths is also off.
      const g = await geo(page);
      const p = at(g, 110, 250);
      await page.mouse.click(p.x, p.y);
      expect(await selection(page)).toEqual([]);
    });

    test('when the layout is unavailable, only the editability overlay is turned on and the title gives the reason', async ({
      page,
    }) => {
      const other = await page.context().newPage();
      const pageErrors = await openEditHarness(other, config({ layout2: undefined }));
      await other.waitForFunction(
        () =>
          (
            window as unknown as {
              __controller: { getState(): { edit: { editability: { status: string } } } };
            }
          ).__controller.getState().edit.editability.status === 'ready',
      );
      const btn = other.locator('#pe-overlay-toggle');
      await btn.click();
      await expect(other.locator('#pe-marks')).toBeVisible();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      await expect(btn).toBeEnabled();
      await expect(btn).toHaveAttribute('title', /레이아웃을 쓸 수 없어 편집 가능 표시만 켭니다/);
      await expect(other.locator('#pe-layout-canvas')).toHaveCount(0);
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'false');
      await expect(other.locator('#pe-marks')).toHaveCount(0);
      expect(pageErrors).toEqual([]);
      await other.close();
    });

    test('hovering shows a kind and reason tooltip (restricted paths show the reason)', async ({
      page,
    }) => {
      await page.click('#pe-overlay-toggle');
      const g = await geo(page);
      const lim = at(g, 320, 310);
      await page.mouse.move(lim.x, lim.y);
      const tip = page.locator('#pe-mark-tip');
      await expect(tip).toContainText('패스 · 제한');
      await expect(tip).toContainText('클립');
      const cell = at(g, 70, 315);
      await page.mouse.move(cell.x, cell.y);
      await expect(tip).toContainText('표 셀 · 편집 가능');
    });
  });

  test.describe('path selection', () => {
    test('Alt+click: the smallest path when overlapping, works even with the overlay off. Clicking an empty spot clears', async ({
      page,
    }) => {
      const g = await geo(page);
      const inner = at(g, 140, 220);
      await altClick(page, inner.x, inner.y);
      await expect(page.locator('#pe-path-layer')).toHaveAttribute('data-count', '1');
      expect(await selection(page)).toEqual([11]);
      await expect(page.locator('#pe-path-panel')).toBeVisible();
      const outer = at(g, 110, 250);
      await altClick(page, outer.x, outer.y);
      expect(await selection(page)).toEqual([10]);
      const empty = at(g, 500, 380);
      await page.mouse.click(empty.x, empty.y);
      await expect(page.locator('#pe-path-layer')).toHaveCount(0);
    });

    test('click without Alt: does not select when the overlay is off, selects when on', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 110, 250);
      await page.mouse.click(p.x, p.y);
      expect(await selection(page)).toEqual([]);
      await page.click('#pe-overlay-toggle');
      await page.mouse.click(p.x, p.y);
      expect(await selection(page)).toEqual([10]);
    });

    test('a line is hit within 4px on screen', async ({ page }) => {
      const g = await geo(page);
      const near = at(g, 420, 200);
      await altClick(page, near.x, near.y + 3);
      expect(await selection(page)).toEqual([13]);
      await page.mouse.click(g.x + 5, g.y + 5);
      await altClick(page, near.x, near.y + 12);
      expect(await selection(page)).toEqual([]);
    });

    test('Shift+click multi-selection (add and remove)', async ({ page }) => {
      const g = await geo(page);
      const a = at(g, 140, 220);
      const b = at(g, 110, 250);
      await altClick(page, a.x, a.y);
      await altClick(page, b.x, b.y, ['Alt', 'Shift']);
      await expect(page.locator('#pe-path-layer')).toHaveAttribute('data-count', '2');
      expect(await selection(page)).toEqual([11, 10]);
      await altClick(page, a.x, a.y, ['Alt', 'Shift']);
      await expect.poll(() => selection(page)).toEqual([10]);
      expect(await selection(page)).toEqual([10]);
    });

    test('non-editable path: only a reason notice, no handles or color picker', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 320, 310);
      await altClick(page, p.x, p.y);
      await expect(page.locator('#pe-path-note')).toContainText('clip-path');
      await expect(page.locator('.pe-path-handle')).toHaveCount(0);
      await expect(page.locator('#pe-path-fill')).toHaveCount(0);
    });
  });

  test.describe('path editing', () => {
    async function select(page: Page, x: number, y: number, extra: ('Alt' | 'Shift')[] = ['Alt']) {
      const g = await geo(page);
      const p = at(g, x, y);
      await altClick(page, p.x, p.y, extra);
      await expect(page.locator('#pe-path-box')).toBeVisible();
      return g;
    }

    test('drag: preview (before the server update), update after a 200 ms idle, commit on release', async ({
      page,
    }) => {
      const g = await select(page, 140, 220);
      const box = (await page.locator('#pe-path-box').boundingBox())!;
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 15, sy + 6, { steps: 5 });
      await expect(page.locator('#pe-path-preview')).toBeVisible();
      expect(await calls(page, 'updatePathDraft')).toBe(0);
      await page.waitForTimeout(260);
      expect(await calls(page, 'updatePathDraft')).toBe(1);
      await expect(page.locator('#pe-path-preview')).toHaveCount(0); // the server region is applied
      await page.mouse.move(sx + 30, sy + 12, { steps: 3 });
      await page.mouse.up();
      await expect.poll(() => edits(page)).toBe(1);
      const e = (await pathEdits(page)).at(-1)!;
      expect(e.transform![0]).toBeCloseTo(1, 6);
      expect(e.transform![4]).toBeCloseTo(30 / g.scale, 0);
      expect(e.transform![5]).toBeCloseTo(12 / g.scale, 0);
      const info = await pathInfo(page, 11);
      expect(info!.bbox[0]).toBeCloseTo(130 + 30 / g.scale, 0);
      expect(await selection(page)).toEqual([11]); // selection is kept after the edit
      expect(await calls(page, 'commitPathEdit')).toBe(1);
    });

    test('Esc: cancelling mid-drag leaves the document unchanged', async ({ page }) => {
      await select(page, 140, 220);
      const box = (await page.locator('#pe-path-box').boundingBox())!;
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 30, sy, { steps: 4 });
      await page.waitForTimeout(260);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect.poll(() => calls(page, 'cancelPathEdit')).toBe(1);
      expect(await calls(page, 'commitPathEdit')).toBe(0);
      expect(await edits(page)).toBe(0);
      expect((await pathInfo(page, 11))!.bbox).toEqual([130, 210, 160, 230]);
    });

    test('handle resize: opposite corner fixed, Shift keeps the aspect ratio', async ({ page }) => {
      await select(page, 140, 220);
      const handle = page.locator('.pe-path-handle[data-handle="se"]');
      const hb = (await handle.boundingBox())!;
      const x = hb.x + hb.width / 2;
      const y = hb.y + hb.height / 2;
      await page.mouse.move(x, y);
      await page.keyboard.down('Shift');
      await page.mouse.down();
      await page.mouse.move(x + 60, y + 3, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect.poll(() => edits(page)).toBe(1);
      const t = (await pathEdits(page)).at(-1)!.transform!;
      expect(t[0]).toBeCloseTo(t[3]!, 6);
      expect(t[0]!).toBeGreaterThan(1);
      const info = (await pathInfo(page, 11))!;
      expect(info.bbox[0]).toBeCloseTo(130, 3); // top-left fixed
      expect(info.bbox[1]).toBeCloseTo(210, 3);
    });

    test('color picker: continuous input is not sent, only one commit on close (change)', async ({
      page,
    }) => {
      await select(page, 140, 220);
      await page.evaluate(() => {
        const el = document.getElementById('pe-path-fill') as HTMLInputElement;
        for (const v of ['#110000', '#220000', '#00ff00']) {
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await page.waitForTimeout(300);
      expect(await calls(page, 'beginPathEdit')).toBe(0);
      await page.evaluate(() =>
        document
          .getElementById('pe-path-fill')!
          .dispatchEvent(new Event('change', { bubbles: true })),
      );
      await expect.poll(() => edits(page)).toBe(1);
      expect(await calls(page, 'commitPathEdit')).toBe(1);
      expect((await pathEdits(page)).at(-1)!.fill).toEqual([0, 1, 0]);
      expect((await pathInfo(page, 11))!.color!.rgb).toEqual([0, 1, 0]);
    });

    test('line width panel', async ({ page }) => {
      await select(page, 420, 200, ['Alt']);
      const input = page.locator('#pe-path-width');
      await expect(input).toHaveValue('2');
      await input.fill('4');
      await input.dispatchEvent('change');
      await expect.poll(() => edits(page)).toBe(1);
      expect((await pathInfo(page, 13))!.lineWidth).toBe(4);
    });

    test('point edit mode: vertices and control points shown, dragging commits as PathEdit.points', async ({
      page,
    }) => {
      const geoNow = await geo(page);
      const mid = at(geoNow, 350, 62.5);
      await altClick(page, mid.x, mid.y);
      expect(await selection(page)).toEqual([14]);
      await page.click('#pe-path-points');
      const points = page.locator('.pe-path-point');
      await expect(points).toHaveCount(4);
      await expect(page.locator('.pe-path-point[data-kind="control"]')).toHaveCount(2);
      await expect(page.locator('.pe-path-handle')).toHaveCount(0);
      const end = page.locator('.pe-path-point[data-index="3"]');
      const b = (await end.boundingBox())!;
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 15, y - 9, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => edits(page)).toBe(1);
      const e = (await pathEdits(page)).at(-1)!;
      expect(e.points).toHaveLength(1);
      expect(e.points![0]!.index).toBe(3);
      expect(e.points![0]!.to[0]).toBeCloseTo(400 + 15 / geoNow.scale, 0);
      expect(e.points![0]!.to[1]).toBeCloseTo(100 - 9 / geoNow.scale, 0);
      expect(e.transform).toBeNull();
      // Esc during point editing: ends the mode; once more: clears the selection
      await page.keyboard.press('Escape');
      await expect(page.locator('.pe-path-point')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('#pe-path-layer')).toHaveCount(0);
    });

    test('point editing is unavailable in multi-selection', async ({ page }) => {
      await select(page, 140, 220);
      await expect(page.locator('#pe-path-points')).toBeEnabled();
      const g = await geo(page);
      const b = at(g, 110, 250);
      await altClick(page, b.x, b.y, ['Alt', 'Shift']);
      await expect(page.locator('#pe-path-points')).toBeDisabled();
    });

    test('multi-selection move is one edit, the Delete key deletes the multi-selection at once', async ({
      page,
    }) => {
      await select(page, 140, 220);
      const g = await geo(page);
      const b = at(g, 110, 250);
      await altClick(page, b.x, b.y, ['Alt', 'Shift']);
      const box = (await page.locator('#pe-path-box').boundingBox())!;
      const sx = box.x + 8;
      const sy = box.y + box.height - 8;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 21, sy, { steps: 3 });
      await page.mouse.up();
      await expect.poll(() => edits(page)).toBe(1);
      expect((await pathInfo(page, 10))!.bbox[0]).toBeCloseTo(100 + 21 / g.scale, 0);
      expect((await pathInfo(page, 11))!.bbox[0]).toBeCloseTo(130 + 21 / g.scale, 0);
      await page.keyboard.press('Delete');
      await expect.poll(() => edits(page)).toBe(2);
      expect(await pathInfo(page, 10)).toBeNull();
      expect(await pathInfo(page, 11)).toBeNull();
      expect((await pathEdits(page)).at(-1)!.delete).toBe(true);
      await expect(page.locator('#pe-path-layer')).toHaveCount(0);
    });

    test('delete button + document undo', async ({ page }) => {
      await select(page, 140, 220);
      await page.click('#pe-path-delete');
      await expect.poll(() => edits(page)).toBe(1);
      expect(await pathInfo(page, 11)).toBeNull();
      await page.click('#pe-doc-undo');
      await expect.poll(() => edits(page)).toBe(0);
      expect(await selection(page)).toEqual([]);
    });
  });

  test.describe('table grid (merged cell basis)', () => {
    test('the grid draws a merged range as one cell', async ({ page }) => {
      await page.click('#pe-overlay-toggle');
      const canvas = page.locator('#pe-layout-canvas');
      await expect(canvas).toBeVisible();
      // 3 merged cells + 4 uncovered empty cells = 7 (full row/column lines would cut across the merged cells)
      await expect(canvas).toHaveAttribute('data-grid-cells', '7');
    });
  });
});
