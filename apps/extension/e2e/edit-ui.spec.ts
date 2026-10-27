/**
 * M3 viewer-ui editor e2e (docs/m3-viewer-ui.md).
 *
 * Serves only the viewer-ui build output with a fake edit host (simple reflow with constant glyph width) and checks the editor UI in a real Chromium:
 * entry (border, double-click, restriction reason), input, keys and clipboard, IME scenarios I1–I8 (CDP `Input.imeSetComposition` and `Input.insertText`),
 * compositing position of the changed region, overflow 3-choice, region handles, fallback and missing-glyph display, warning and tag notices, document undo/redo, recovery.
 * Flows that need the real core edit RPC are left as `test.skip` in the `integration` block and enabled at integration (docs/m3-viewer-ui.md section 5).
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { PageModel } from '@pdf-editor/shared-types';
import {
  editModel,
  openEditHarness,
  startEditHarness,
  stopEditHarness,
  type EditHarnessConfig,
} from './edit-harness.js';

// ── Harness setup ────────────────────────────────────────────────────

/**
 * Paragraph 1: editable "Hello World" (region [20,20,130,60], 11 glyphs on one line, up to two lines fit).
 * Paragraph 2: restricted (table cell). Paragraph 3: tagged page (has MCID). 10×14pt glyph grid, line 0 is y 20–34.
 */
const PARAGRAPHS = [
  { id: 1, bbox: [20, 20, 130, 60] as [number, number, number, number], text: 'Hello World' },
  {
    id: 2,
    bbox: [20, 100, 50, 114] as [number, number, number, number],
    text: '표 셀',
    editable: false,
    reasons: ['not-flow-paragraph'],
  },
  {
    id: 3,
    bbox: [20, 160, 130, 174] as [number, number, number, number],
    text: 'tagged',
    tagged: true,
  },
];

const MODEL: PageModel = editModel();

function config(extra: Partial<EditHarnessConfig> = {}): EditHarnessConfig {
  return { model: MODEL, paragraphs: PARAGRAPHS, cssScale: 1.5, ...extra };
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

/** Page space (pt) → screen coordinates. */
const at = (g: Geo, x: number, y: number) => ({ x: g.x + x * g.scale, y: g.y + y * g.scale });

/** Screen coordinates of glyph col on the first line (ratio fx inside the glyph box). */
const charAt = (g: Geo, col: number, fx = 0.5) => at(g, 20 + col * 10 + fx * 10, 27);

/** Edit session read from `window.__controller` in the browser (part of `EditSessionView`). */
interface PageSession {
  editor: { text: string; caret: number; anchor: number; composition: [number, number] | null };
  shown: {
    text: string;
    reflow: { area: number[]; overflow: boolean; lines: unknown[] };
  };
  updating: boolean;
  canUndo: boolean;
  canRedo: boolean;
}
interface PageWindow {
  __controller: { getState(): { edit: { session: PageSession | null } } };
}

interface SessionInfo {
  text: string;
  caret: number;
  anchor: number;
  composition: [number, number] | null;
  shownText: string;
  updating: boolean;
  canUndo: boolean;
  canRedo: boolean;
  area: number[];
  overflow: boolean;
  lines: number;
}

async function session(page: Page): Promise<SessionInfo | null> {
  return page.evaluate(() => {
    const w = window as unknown as PageWindow;
    const s = w.__controller.getState().edit.session;
    if (!s) return null;
    return {
      text: s.editor.text,
      caret: s.editor.caret,
      anchor: s.editor.anchor,
      composition: s.editor.composition,
      shownText: s.shown.text,
      updating: s.updating,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      area: s.shown.reflow.area,
      overflow: s.shown.reflow.overflow,
      lines: s.shown.reflow.lines.length,
    };
  });
}

/** Waits until all sent input has been processed and the screen frame equals the model. */
async function settled(page: Page): Promise<SessionInfo> {
  await page.waitForFunction(() => {
    const w = window as unknown as PageWindow;
    const s = w.__controller.getState().edit.session;
    return !!s && !s.updating && s.shown.text === s.editor.text;
  });
  return (await session(page))!;
}

async function ended(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __controller: { getState(): { edit: { session: unknown } } } }
      ).__controller.getState().edit.session === null,
  );
}

/** Double-clicks paragraph 1 to start editing (the caret is before or after the clicked glyph). */
async function startEdit(page: Page, col = 6, fx = 0.2): Promise<Geo> {
  const g = await geo(page);
  const p = charAt(g, col, fx);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForSelector('#pe-edit-layer');
  await settled(page);
  return g;
}

async function hostCalls(page: Page, method: string): Promise<number> {
  return page.evaluate(
    (m) => (window as unknown as { __edit: { count(m: string): number } }).__edit.count(m),
    method,
  );
}

/** Pixel RGB of a point (pt) on the page canvas. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.getElementById('page-canvas') as HTMLCanvasElement;
      const scale =
        Number(document.getElementById('pe-page')!.dataset.cssScale) * window.devicePixelRatio;
      const d = canvas
        .getContext('2d')!
        .getImageData(Math.round(px! * scale), Math.round(py! * scale), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    [x, y],
  );
}

async function caretInfo(page: Page) {
  const el = page.locator('#pe-edit-caret');
  return {
    offset: Number(await el.getAttribute('data-offset')),
    x: Number(await el.getAttribute('data-x')),
    line: Number(await el.getAttribute('data-line')),
    top: Number(await el.getAttribute('data-top')),
  };
}

async function cdp(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

async function compose(client: CDPSession, text: string): Promise<void> {
  await client.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

const insert = (client: CDPSession, text: string) => client.send('Input.insertText', { text });

let errors: string[] = [];
test.describe('M3 editor UI (fake edit host)', () => {
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

  // ── Entry ──────────────────────────────────────────────────────────

  test.describe('entry', () => {
    test('mouse over: solid border for editable paragraphs, dashed border (different color) for restricted ones', async ({
      page,
    }) => {
      const g = await geo(page);
      const over = at(g, 60, 30);
      await page.mouse.move(over.x, over.y);
      const hover = page.locator('#pe-edit-hover');
      await expect(hover).toBeVisible();
      await expect(hover).toHaveAttribute('data-editable', '1');
      const box = await hover.boundingBox();
      expect(Math.abs(box!.x - (g.x + 20 * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(box!.width - 110 * g.scale)).toBeLessThan(0.75);
      const restricted = at(g, 30, 105);
      await page.mouse.move(restricted.x, restricted.y);
      await expect(hover).toHaveAttribute('data-editable', '0');
      expect(await hover.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('dashed');
      await page.mouse.move(g.x + 5, g.y + 400);
      await expect(hover).toHaveCount(0);
    });

    test('double-click: the edit layer opens, the caret is at the clicked glyph position, the input textarea has focus', async ({
      page,
    }) => {
      const g = await startEdit(page, 6, 0.2); // left half of 'W' → before offset 6
      expect((await caretInfo(page)).offset).toBe(6);
      expect((await caretInfo(page)).x).toBe(80);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pe-edit-input');
      await expect(page.locator('#pe-text-layer')).toHaveCount(0);
      const area = await page.locator('#pe-edit-area').boundingBox();
      expect(Math.abs(area!.x - (g.x + 20 * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(area!.height - 40 * g.scale)).toBeLessThan(0.75);
      // Clicking the right half of a glyph puts the caret after it
      await page.keyboard.press('Escape');
      await ended(page);
      await startEdit(page, 6, 0.8);
      expect((await caretInfo(page)).offset).toBe(7);
    });

    test('a single click or drag keeps the existing text selection (editing does not start)', async ({
      page,
    }) => {
      const g = await geo(page);
      const a = charAt(g, 1);
      const b = charAt(g, 4);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await page.mouse.up();
      expect(await session(page)).toBeNull();
      await expect(page.locator('#pe-text-layer')).toBeVisible();
    });

    test('double-click on a restricted paragraph: shows the reason popover and does not start editing', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 30, 105);
      await page.mouse.dblclick(p.x, p.y);
      const pop = page.locator('#pe-edit-popover');
      await expect(pop).toBeVisible();
      await expect(pop).toContainText('표 셀 안 글자입니다(테스트).');
      expect(await session(page)).toBeNull();
      expect(await hostCalls(page, 'beginParagraphEdit')).toBe(0);
      await page.keyboard.press('Escape');
      await expect(pop).toHaveCount(0);
      await page.mouse.dblclick(p.x, p.y);
      await expect(pop).toBeVisible();
      await page.mouse.click(g.x + 400, g.y + 300);
      await expect(pop).toHaveCount(0);
    });

    test('a tagged-page paragraph shows a notice and can be blocked by a setting (D1)', async ({
      page,
    }) => {
      const g = await geo(page);
      const p = at(g, 60, 167);
      await page.mouse.dblclick(p.x, p.y);
      await page.waitForSelector('#pe-edit-layer');
      await expect(page.locator('#pe-edit-tagged-note')).toContainText(
        '구조(읽기 순서·태그)는 갱신하지 않습니다',
      );
      await page.locator('#pe-edit-cancel').click();
      await ended(page);
      await page.locator('#pe-block-tagged').check();
      await page.mouse.dblclick(p.x, p.y);
      await expect(page.locator('#pe-edit-popover')).toContainText('태그 PDF');
      expect(await session(page)).toBeNull();
    });
  });

  // ── Input ──────────────────────────────────────────────────────────

  test.describe('input and keys', () => {
    test('typing: model, caret and changed-region compositing (glyph position pixels) are correct', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8); // offset 11 (end)
      expect(await pixel(page, 125, 26)).toEqual([0x22, 0x22, 0x22]); // the 11th glyph of the start frame
      expect(await pixel(page, 25, 46)).toEqual([255, 255, 255]); // the second line is empty
      await page.keyboard.type('abc');
      const s = await settled(page);
      expect(s.text).toBe('Hello Worldabc');
      expect(s.caret).toBe(14);
      expect(s.lines).toBe(2);
      // The line breaks at the last space (after "Hello "), and the 8 glyphs of "Worldabc" are composited on the second line (baseline 52, box 41–52).
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 95, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 105, 46)).toEqual([255, 255, 255]);
      const caret = await caretInfo(page);
      expect([caret.offset, caret.x, caret.line]).toEqual([14, 100, 1]);
    });

    test('Backspace, Delete, arrows, Home/End, Shift selection, Ctrl+A', async ({ page }) => {
      await startEdit(page, 6, 0.2); // offset 6
      await page.keyboard.press('Backspace');
      expect((await settled(page)).text).toBe('HelloWorld');
      await page.keyboard.press('Delete');
      expect((await settled(page)).text).toBe('Helloorld');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect((await session(page))!.caret).toBe(3);
      await page.keyboard.press('Home');
      expect((await session(page))!.caret).toBe(0);
      await page.keyboard.press('Shift+End');
      let s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([0, 9]);
      await expect(page.locator('.pe-edit-sel')).toHaveCount(1);
      await page.keyboard.press('ArrowRight'); // with a selection, collapses to its end
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([9, 9]);
      await page.keyboard.press('Control+A');
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([0, 9]);
      await page.keyboard.type('X');
      expect((await settled(page)).text).toBe('X');
    });

    test('Enter is a forced line break, ↑/↓ follow reflow lines, Home/End within a line', async ({
      page,
    }) => {
      await startEdit(page, 4, 0.8); // offset 5
      await page.keyboard.press('Enter');
      expect((await settled(page)).text).toBe('Hello\n World');
      expect((await caretInfo(page)).line).toBe(1);
      await page.keyboard.press('ArrowUp');
      let c = await caretInfo(page);
      expect([c.line, c.offset]).toEqual([0, 0]); // keeps the target x (start of the second line = 20pt)
      await page.keyboard.press('ArrowDown');
      c = await caretInfo(page);
      expect(c.line).toBe(1);
      await page.keyboard.press('End');
      expect((await session(page))!.caret).toBe(12);
      await page.keyboard.press('Home');
      expect((await session(page))!.caret).toBe(6);
    });

    test('paste: text only, line breaks become forced line breaks, NFC normalization, NBSP → space', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.evaluate(() => {
        const ta = document.getElementById('pe-edit-input')!;
        const dt = new DataTransfer();
        dt.setData('text/html', '<b>굵게</b>');
        dt.setData('text/plain', 'A\r\nB한\u00a0C');
        ta.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      });
      expect((await settled(page)).text).toBe('Hello WorldA\nB한 C');
    });

    test('copy and cut use the editor selection text', async ({ page }) => {
      await startEdit(page, 0, 0.2);
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      const copied = await page.evaluate(() => {
        const ta = document.getElementById('pe-edit-input')!;
        const dt = new DataTransfer();
        ta.dispatchEvent(
          new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
        const out1 = dt.getData('text/plain');
        const dt2 = new DataTransfer();
        ta.dispatchEvent(
          new ClipboardEvent('cut', { clipboardData: dt2, bubbles: true, cancelable: true }),
        );
        return [out1, dt2.getData('text/plain')];
      });
      expect(copied).toEqual(['He', 'He']);
      expect((await settled(page)).text).toBe('llo World');
    });

    test('click, drag, double-click and triple-click set the caret and selection', async ({
      page,
    }) => {
      const g = await startEdit(page, 10, 0.8);
      const a = charAt(g, 2, 0.9); // offset 3 boundary
      await page.mouse.click(a.x, a.y);
      expect((await session(page))!.caret).toBe(3);
      const b = charAt(g, 8, 0.2);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 3 });
      await page.mouse.up();
      let s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([3, 8]);
      const w = charAt(g, 7);
      await page.mouse.dblclick(w.x, w.y);
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([6, 11]); // "World"
      await page.mouse.click(w.x, w.y, { clickCount: 3 });
      s = (await session(page))!;
      expect([s.anchor, s.caret]).toEqual([0, 11]);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('pe-edit-input');
    });

    test('per-glyph undo while editing: continuous input is one unit, broken after a space', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      for (const ch of ['a', 'b', ' ', 'c', 'd']) await insert(client, ch);
      expect((await settled(page)).text).toBe('Hello Worldab cd');
      await page.keyboard.press('Control+Z');
      expect((await settled(page)).text).toBe('Hello Worldab '); // "cd" is one unit
      await page.keyboard.press('Control+Z');
      expect((await settled(page)).text).toBe('Hello World'); // "ab " is one unit
      await page.keyboard.press('Control+Shift+Z');
      expect((await settled(page)).text).toBe('Hello Worldab ');
      await page.keyboard.press('Control+Y');
      expect((await settled(page)).text).toBe('Hello Worldab cd');
      // Ctrl+Z while editing is not a document undo.
      expect(await hostCalls(page, 'undo')).toBe(0);
    });
  });

  // ── IME scenarios (contract 1.3) ─────────────────────────────────────────

  test.describe('IME I1–I8', () => {
    test('I1: during composition the underline and caret are at the end of the composition, and committing inserts one syllable', async ({
      page,
    }) => {
      await startEdit(page, 6, 0.2); // offset 6
      const client = await cdp(page);
      await compose(client, 'ㅎ');
      let s = await settled(page);
      expect(s.text).toBe('Hello ㅎWorld');
      expect(s.composition).toEqual([6, 7]);
      expect((await caretInfo(page)).offset).toBe(7);
      await expect(page.locator('.pe-edit-comp')).toHaveCount(1);
      await expect(page.locator('#pe-edit-layer')).toHaveAttribute('data-composing', '1');
      await compose(client, '하');
      await compose(client, '한');
      s = await settled(page);
      expect(s.text).toBe('Hello 한World');
      // The underline is below the composition span (1 glyph), and its right end is the caret position (it follows even when the line wraps).
      const under = await page.locator('.pe-edit-comp').boundingBox();
      const g = await geo(page);
      const caret = await caretInfo(page);
      expect(Math.abs(under!.x + under!.width - (g.x + caret.x * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(under!.width - 10 * g.scale)).toBeLessThan(0.75);
      await insert(client, '한'); // commit
      s = await settled(page);
      expect(s.text).toBe('Hello 한World');
      expect(s.composition).toBeNull();
      expect(s.caret).toBe(7);
      await expect(page.locator('.pe-edit-comp')).toHaveCount(0);
      // The committed glyph '한' is composited at the start of the second line (x 20–30, box 41–52) because of line wrapping.
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]);
    });

    test('I2: deleting a jamo during composition updates only the composition string', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '한');
      await compose(client, '하');
      expect((await settled(page)).text).toBe('Hello World하');
      await compose(client, '');
      const s = await settled(page);
      expect(s.text).toBe('Hello World');
      expect(s.composition).toBeNull();
      await expect(page.locator('.pe-edit-comp')).toHaveCount(0);
    });

    test('I3: even when a composed glyph wraps to the next line at the line end, the caret and underline follow', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8); // offset 11 (the first line is full)
      const client = await cdp(page);
      await compose(client, '가나');
      const s = await settled(page);
      expect(s.composition).toEqual([11, 13]);
      const caret = await caretInfo(page);
      // The line breaks after "Hello ", so "World가나" becomes the second line: caret x = 20 + 7 glyphs.
      expect([caret.offset, caret.line, caret.x]).toEqual([13, 1, 90]);
      const under = await page.locator('.pe-edit-comp').boundingBox();
      const g = await geo(page);
      // The underline is below the second line of the composition span (second-line glyphs 5–7 = x 70–90) (baseline 52 + descent 3 = 55pt).
      expect(Math.abs(under!.y - (g.y + 55 * g.scale))).toBeLessThan(1.5);
      expect(Math.abs(under!.x - (g.x + 70 * g.scale))).toBeLessThan(0.75);
      expect(Math.abs(under!.width - 20 * g.scale)).toBeLessThan(0.75);
    });

    test('I4: clicking during composition commits the composition and then moves the caret', async ({
      page,
    }) => {
      const g = await startEdit(page, 6, 0.2);
      const client = await cdp(page);
      await compose(client, 'ㅎ');
      await settled(page);
      const p = charAt(g, 1, 0.2); // offset 1
      await page.mouse.click(p.x, p.y);
      const s = await settled(page);
      expect(s.text).toBe('Hello ㅎWorld');
      expect(s.composition).toBeNull();
      expect(s.caret).toBe(1);
      await expect(page.locator('.pe-edit-comp')).toHaveCount(0);
    });

    test('I4: arrows during composition are ignored (the IME handles them) and move after commit', async ({
      page,
    }) => {
      await startEdit(page, 6, 0.2);
      const client = await cdp(page);
      await compose(client, 'ㅎ');
      await settled(page);
      await page.keyboard.press('ArrowLeft');
      expect((await session(page))!.caret).toBe(7); // does not move
      await insert(client, 'ㅎ');
      await settled(page);
      await page.keyboard.press('ArrowLeft');
      expect((await session(page))!.caret).toBe(6);
    });

    test('I5: Ctrl+Z during composition is ignored', async ({ page }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await insert(client, 'q'); // even if there is undoable input
      await compose(client, '가');
      await settled(page);
      await page.keyboard.press('Control+Z');
      const s = await settled(page);
      expect(s.text).toBe('Hello Worldq가');
      expect(s.composition).toEqual([12, 13]);
      await insert(client, '가');
      expect((await settled(page)).text).toBe('Hello Worldq가');
    });

    test('I6: one composition commit is the same undo unit as the input before and after', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await insert(client, 'x');
      await compose(client, '한');
      await insert(client, '한');
      await insert(client, 'y');
      expect((await settled(page)).text).toBe('Hello Worldx한y');
      await page.keyboard.press('Control+Z');
      expect((await settled(page)).text).toBe('Hello World');
    });

    test('I7: Hanja conversion results are inserted, and glyphs without a glyph are marked and warned', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '漢');
      await insert(client, '漢');
      expect((await settled(page)).text).toBe('Hello World漢');
      // U+2603 is handled by the fake host as "no glyph in either the original or the fallback".
      await insert(client, '☃');
      await settled(page);
      await expect(page.locator('.pe-edit-missing')).toHaveCount(1);
      await expect(page.locator('#pe-edit-warnings li[data-kind="glyph-missing"]')).toBeVisible();
    });

    test('I8: a click outside during composition commits the composition and then commits the edit', async ({
      page,
    }) => {
      const g = await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '한');
      await settled(page);
      await page.mouse.click(g.x + 400, g.y + 500);
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
      const sent = await page.evaluate(() =>
        (
          window as unknown as {
            __edit: { inputs: { runs: { text: string }[]; composition: unknown }[] };
          }
        ).__edit.inputs.at(-1),
      );
      expect(sent!.runs.map((r) => r.text).join('')).toBe('Hello World한');
      expect(sent!.composition).toBeNull();
    });

    test('I8: Esc during composition does not end editing (the IME uses it first)', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await compose(client, '한');
      await settled(page);
      await page.keyboard.press('Escape');
      expect(await session(page)).not.toBeNull();
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      await insert(client, '한');
      await settled(page);
      await page.keyboard.press('Escape'); // commits when not composing
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
    });
  });

  // ── End ──────────────────────────────────────────────────────────

  test.describe('end', () => {
    test('Esc = commit (with changes), same as cancel when there are no changes', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'cancelParagraphEdit')).toBe(1);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('z');
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
      await page.waitForFunction(() => (window as unknown as { __renders: number }).__renders >= 2);
    });

    test('click outside = commit; clicks on the region, handles or overflow panel do not commit', async ({
      page,
    }) => {
      const g = await startEdit(page, 10, 0.8);
      await page.keyboard.type('z');
      const inside = charAt(g, 2);
      await page.mouse.click(inside.x, inside.y);
      expect(await session(page)).not.toBeNull();
      await page.mouse.click(g.x + 450, g.y + 600);
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
    });

    test('toolbar "편집 취소" (cancel edit): discards the draft and the page canvas returns to before the edit', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdefghijkl');
      await settled(page);
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]); // the second line is composited
      await page.locator('#pe-edit-cancel').click();
      await ended(page);
      expect(await hostCalls(page, 'cancelParagraphEdit')).toBe(1);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      // Restore from the reference bitmap (pre-edit render, white background)
      expect(await pixel(page, 25, 46)).toEqual([255, 255, 255]);
      expect(await pixel(page, 125, 26)).toEqual([255, 255, 255]);
      await expect(page.locator('#pe-text-layer')).toBeVisible();
    });

    test('after a commit, redraws the page and reloads the text layer and edit classification', async ({
      page,
    }) => {
      const before = await page.evaluate(
        () => (window as unknown as { __renders: number }).__renders,
      );
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('!');
      await page.keyboard.press('Escape');
      await ended(page);
      await page.waitForFunction(
        (n) => (window as unknown as { __renders: number }).__renders > n,
        before,
      );
      await expect(page.locator('#pe-text-layer')).toBeVisible();
      await page.waitForFunction(
        () =>
          (
            window as unknown as {
              __controller: { getState(): { edit: { editability: { status: string } } } };
            }
          ).__controller.getState().edit.editability.status === 'ready',
      );
    });
  });

  // ── Overflow UI and region ───────────────────────────────────────────────────

  test.describe('overflow and region', () => {
    /** 80pt below the region upper bound: 5 lines (47 glyphs) do not fit even with auto expansion. */
    async function blocked(page: Page): Promise<void> {
      errors.length = 0;
      errors = await openEditHarness(page, config({ areaLimit: [0, 0, 612, 80] }));
      await page.waitForSelector('#pe-text-layer');
      await page.waitForFunction(
        () =>
          (
            window as unknown as {
              __controller: { getState(): { edit: { editability: { status: string } } } };
            }
          ).__controller.getState().edit.editability.status === 'ready',
      );
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123456789'); // 11 + 36 glyphs = 5 lines
      await settled(page);
    }

    test('on overflow the region bottom edge grows automatically to the text height and there is no choice UI', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const before = await settled(page);
      await page.keyboard.type('abcdefghijklmnopqrstuvw'); // 3 lines
      const after = await settled(page);
      expect(after.lines).toBeGreaterThanOrEqual(3);
      expect(after.overflow).toBe(false);
      expect(after.area[3]!).toBeGreaterThan(before.area[3]!);
      await expect(page.locator('#pe-edit-area')).toHaveAttribute('data-overflow', '0');
      await expect(page.locator('#pe-edit-overflow-line')).toHaveCount(0);
      await expect(page.locator('#pe-edit-overflow')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '영역 넓히기' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '글자 줄이기' })).toHaveCount(0);
      // The border (#pe-edit-area) also draws the widened region: down past the third-line baseline (72).
      const area = (await page.locator('#pe-edit-area').getAttribute('data-area'))!
        .split(',')
        .map(Number);
      expect(area[3]!).toBeGreaterThan(72);
      // Deleting returns to the original region (same rule for every input).
      for (let i = 0; i < 23; i++) await page.keyboard.press('Backspace');
      expect((await settled(page)).area).toEqual(before.area);
    });

    test('even if the bottom edge is raised above the text with the handle, it grows back to the text height', async ({
      page,
    }) => {
      const g = await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdefghijklmnopqrstuvw'); // 3 lines
      const full = await settled(page);
      const handle = await page.locator('.pe-edit-handle[data-handle="s"]').boundingBox();
      const hx = handle!.x + handle!.width / 2;
      const hy = handle!.y + handle!.height / 2;
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      await page.mouse.move(hx, hy - 40 * g.scale, { steps: 4 });
      await page.mouse.up();
      const s = await settled(page);
      expect(s.overflow).toBe(false);
      expect(s.area[3]).toBeCloseTo(full.area[3]!, 3);
    });

    test('when blocked by the region upper bound, only the overflow indicator, the overflow-clipped warning and one "되돌리기" are shown', async ({
      page,
    }) => {
      await blocked(page);
      const s = await session(page);
      expect(s!.overflow).toBe(true);
      expect(s!.area[3]).toBe(80);
      await expect(page.locator('#pe-edit-area')).toHaveAttribute('data-overflow', '1');
      await expect(page.locator('#pe-edit-overflow-line')).toBeVisible();
      const panel = page.locator('#pe-edit-overflow');
      await expect(panel).toBeVisible();
      await expect(panel.locator('button')).toHaveText(['되돌리기']);
      await expect(
        page.locator('#pe-edit-warnings li[data-kind="overflow-clipped"]'),
      ).toBeVisible();
      // Overflowing lines are composited too (no automatic clipping): near the baseline of line 5, 20+12+80 = 112
      expect(await pixel(page, 25, 106)).toEqual([0x22, 0x22, 0x22]);
    });

    test('undo: discards this edit and returns to the state before editing started (same path as cancel edit)', async ({
      page,
    }) => {
      await blocked(page);
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]); // the second line is composited
      await page.locator('#pe-edit-revert').click();
      await ended(page);
      expect(await hostCalls(page, 'cancelParagraphEdit')).toBe(1);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(0);
      expect(await pixel(page, 25, 46)).toEqual([255, 255, 255]);
      expect(await pixel(page, 25, 106)).toEqual([255, 255, 255]);
      await expect(page.locator('#pe-text-layer')).toBeVisible();
    });

    test('Esc commits even when overflow blocked by the upper bound remains (overflow-clipped warning state, user decision)', async ({
      page,
    }) => {
      await blocked(page);
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
      expect(await hostCalls(page, 'cancelParagraphEdit')).toBe(0);
    });

    test('8 region handles, dragging changes the region and it cannot go beyond areaLimit', async ({
      page,
    }) => {
      // Upper bound [0,0,200,100]: the right edge cannot exceed 200pt.
      errors.length = 0;
      await openEditHarness(page, config({ areaLimit: [0, 0, 200, 100] }));
      await page.waitForSelector('#pe-text-layer');
      await page.waitForFunction(
        () =>
          (
            window as unknown as {
              __controller: { getState(): { edit: { editability: { status: string } } } };
            }
          ).__controller.getState().edit.editability.status === 'ready',
      );
      const g = await startEdit(page, 10, 0.8);
      await expect(page.locator('.pe-edit-handle')).toHaveCount(8);
      const handle = await page.locator('.pe-edit-handle[data-handle="e"]').boundingBox();
      const hx = handle!.x + handle!.width / 2;
      const hy = handle!.y + handle!.height / 2;
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      await page.mouse.move(hx + 30 * g.scale, hy, { steps: 4 });
      await page.mouse.up();
      let s = await settled(page);
      expect(s.area[2]).toBeCloseTo(160, 0);
      // Even when dragged much further, it stops at the upper bound (200).
      const handle2 = await page.locator('.pe-edit-handle[data-handle="e"]').boundingBox();
      const hx2 = handle2!.x + handle2!.width / 2;
      await page.mouse.move(hx2, hy);
      await page.mouse.down();
      await page.mouse.move(hx2 + 400 * g.scale, hy, { steps: 4 });
      await page.mouse.up();
      s = await settled(page);
      expect(s.area[2]).toBe(200);
      // After dragging the bottom edge to enlarge the region, the lines are re-broken at the widened line width (more fit on one line).
      expect(s.lines).toBe(1);
    });
  });

  // ── Display ──────────────────────────────────────────────────────────

  test.describe('display', () => {
    test('fallback glyphs get a dotted underline (toggle), missing glyphs are marked', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      const client = await cdp(page);
      await insert(client, '한글');
      await settled(page);
      await expect(page.locator('.pe-edit-fb')).toHaveCount(1);
      expect(
        await page.locator('.pe-edit-fb').evaluate((e) => getComputedStyle(e).borderBottomStyle),
      ).toBe('dotted');
      await page.locator('#pe-fb-toggle').click();
      await expect(page.locator('.pe-edit-fb')).toHaveCount(0);
      await page.locator('#pe-fb-toggle').click();
      await expect(page.locator('.pe-edit-fb')).toHaveCount(1);
    });

    test('the warning list is shown without duplicates, and a notice says the edited page numbers are recorded on save', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await expect(page.locator('#pe-edit-info')).toContainText('편집한 쪽 번호가 파일 정보');
      const client = await cdp(page);
      await insert(client, '☃');
      await insert(client, '☃');
      await settled(page);
      await expect(page.locator('#pe-edit-warnings li[data-kind="glyph-missing"]')).toHaveCount(1);
    });

    test('input → compositing response time is recorded with performance.measure (contract 8.4)', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('abcdef');
      await settled(page);
      const ms = await page.evaluate(() =>
        performance.getEntriesByName('pe-edit-latency').map((e) => e.duration),
      );
      expect(ms.length).toBeGreaterThanOrEqual(1);
      for (const d of ms) expect(d).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ms)).toBeLessThan(2000); // upper bound for the fake host (the measured baseline comes at integration)
    });
  });

  // ── Document undo/redo ────────────────────────────────────────────────

  test.describe('document undo/redo', () => {
    test('Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y outside editing and the toolbar buttons', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('!');
      await page.keyboard.press('Escape');
      await ended(page);
      await expect(page.locator('#pe-doc-undo')).toBeEnabled();
      await expect(page.locator('#pe-doc-redo')).toBeDisabled();
      await page.mouse.click(5, 5); // move focus to the document
      await page.keyboard.press('Control+Z');
      await expect(page.locator('#pe-doc-redo')).toBeEnabled();
      expect(await hostCalls(page, 'undo')).toBe(1);
      await page.keyboard.press('Control+Shift+Z');
      await expect(page.locator('#pe-doc-undo')).toBeEnabled();
      expect(await hostCalls(page, 'redo')).toBe(1);
      await page.keyboard.press('Control+Z');
      await page.keyboard.press('Control+Y');
      await expect.poll(() => hostCalls(page, 'redo')).toBe(2);
      await page.locator('#pe-doc-undo').click();
      await expect.poll(() => hostCalls(page, 'undo')).toBe(3);
      await page.locator('#pe-doc-redo').click();
      await expect.poll(() => hostCalls(page, 'redo')).toBe(3);
    });
  });

  // ── Recovery (D6) ──────────────────────────────────────────────────────

  test.describe('recovery', () => {
    test('when the Worker is recovered during a draft, the same paragraph draft restarts with the editor model', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      await page.keyboard.type('가');
      await settled(page);
      await page.evaluate(() => {
        const w = window as unknown as {
          __edit: {
            simulateRecovery(): void;
            failNext(m: string, e: Error): void;
          };
        };
        w.__edit.simulateRecovery();
        const e = new Error('Worker 를 복구했습니다');
        e.name = 'WorkerRecoveredError';
        w.__edit.failNext('updateParagraphDraft', e);
      });
      await page.keyboard.type('나');
      const s = await settled(page);
      expect(s.text).toBe('Hello World가나');
      expect(s.shownText).toBe('Hello World가나');
      await expect(page.locator('#pe-edit-session-notice')).toContainText('복구');
      expect(await hostCalls(page, 'beginParagraphEdit')).toBe(2);
      await page.keyboard.press('Escape');
      await ended(page);
      expect(await hostCalls(page, 'commitParagraphEdit')).toBe(1);
    });
  });

  // ── devicePixelRatio 2 ────────────────────────────────────────────

  test.describe('devicePixelRatio 2', () => {
    test.use({ deviceScaleFactor: 2 });

    test('the changed region is composited at the render scale (CSS scale × dpr) and overlays stay in CSS px', async ({
      page,
    }) => {
      await startEdit(page, 10, 0.8);
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
      await page.keyboard.type('abc');
      const s = await settled(page);
      expect(s.text).toBe('Hello Worldabc');
      // The start update and the input were both requested with renderScale = 1.5 × 2 = 3.
      const scales = await page.evaluate(() =>
        (window as unknown as { __edit: { inputs: { renderScale: number }[] } }).__edit.inputs.map(
          (i) => i.renderScale,
        ),
      );
      expect(scales.length).toBeGreaterThan(0);
      for (const scale of scales) expect(scale).toBe(3);
      // The canvas bitmap is dpr times, and the compositing position uses the same scale ("Worldabc" second line x 20–100, y 41–52).
      expect(await pixel(page, 25, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 95, 46)).toEqual([0x22, 0x22, 0x22]);
      expect(await pixel(page, 105, 46)).toEqual([255, 255, 255]);
      const caret = await page.locator('#pe-edit-caret').boundingBox();
      const g = await geo(page);
      expect(Math.abs(caret!.x - (g.x + 100 * g.scale))).toBeLessThan(2);
    });
  });
});
