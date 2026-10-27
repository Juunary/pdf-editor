/**
 * M3 integration e2e (real core edit RPC). Enabled in the 2026-10-20 m3 integration (docs/m3-viewer-ui.md section 5, docs/m3-integration.md).
 * The body uses the same DOM identifiers (`#pe-edit-*`) and `?e2e` seam (`window.__pe`) as verified with the fake host.
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseSave } from './toolbar-helpers.js';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');

interface PeWindow {
  __pe: {
    pdf: Record<string, (...args: unknown[]) => Promise<unknown>> & { current: { api: unknown } };
    controller: {
      getState(): { edit: { session: { editor: { text: string } } | null } };
      edit: { currentSession(): { latencies: number[] } | null };
    };
  };
}

test.describe('integration (requires real core edit RPC)', () => {
  let context: BrowserContext;
  let userDataDir: string;
  let extensionId: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-int-'));
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
    // Editing must be on (if the feature is off, #pe-notice gets a "문단 편집" notice).
    await expect(page.locator('#pe-notice', { hasText: '문단 편집' })).toHaveCount(0);
    return page;
  }

  /** Screen coordinates of the first editable paragraph on page 0 (paragraph center). */
  async function firstEditable(page: Page): Promise<{ x: number; y: number; id: number }> {
    const info = await page.evaluate(async () => {
      const pe = (window as unknown as PeWindow).__pe;
      const e = (await pe.pdf.getPageEditability!(0)) as {
        paragraphs: { paragraphId: number; bbox: number[]; editable: boolean }[];
      };
      const p = e.paragraphs.find((q) => q.editable)!;
      const box = document.getElementById('pe-page')!.getBoundingClientRect();
      const scale = Number(document.getElementById('pe-page')!.dataset.cssScale);
      return {
        id: p.paragraphId,
        x: box.left + ((p.bbox[0]! + p.bbox[2]!) / 2) * scale,
        y: box.top + ((p.bbox[1]! + p.bbox[3]!) / 2) * scale,
      };
    });
    return info;
  }

  const editorText = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as PeWindow).__pe.controller.getState().edit.session?.editor.text ??
        null,
    );

  async function cdp(page: Page): Promise<CDPSession> {
    return page.context().newCDPSession(page);
  }

  test('DoD flow: Korean composition → commit → save → reopen → search/copy text → re-edit the same paragraph', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    const client = await cdp(page);
    await client.send('Input.imeSetComposition', {
      text: '한',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await client.send('Input.insertText', { text: '한' });
    expect(await editorText(page)).toContain('한');
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    // Save (downloads path), then reopen
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      chooseSave(page, 'save-downloads'),
    ]);
    const saved = await download.path();
    expect(readFileSync(saved).byteLength).toBeGreaterThan(0);
    const reopened = await open(saved);
    const text = await reopened.evaluate(async () => {
      const m = (await (window as unknown as PeWindow).__pe.pdf.extractPage!({ pageIndex: 0 })) as {
        chars: { text: string }[];
      };
      return m.chars.map((c) => c.text).join('');
    });
    expect(text).toContain('한');
    // The same paragraph can be edited again in a new session (edit block re-edit, /PdfEditorFormat).
    const q = await firstEditable(reopened);
    await reopened.mouse.dblclick(q.x, q.y);
    await expect(reopened.locator('#pe-edit-layer')).toBeVisible();
    expect(await editorText(reopened)).toContain('한');
  });

  test('edit response time (contract 8.4): input → changed region compositing p95 ≤ 100 ms (provisional, fixed by user confirmation after measurement)', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    const client = await cdp(page);
    for (const ch of 'The quick brown fox jumps over the lazy dog') {
      await client.send('Input.insertText', { text: ch });
      await page.waitForFunction(
        () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
      );
    }
    const ms = await page.evaluate(() =>
      performance.getEntriesByName('pe-edit-latency').map((e) => e.duration),
    );
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    console.log(JSON.stringify({ samples: ms.length, p95, max: ms.at(-1) }));
    expect(p95).toBeLessThanOrEqual(100);
  });

  test('fallback (Korean) and missing-glyph warnings match the real plan/draft warnings', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    const client = await cdp(page);
    await client.send('Input.insertText', { text: '한글' }); // a glyph absent from the English subset font → fallback
    await page.waitForFunction(
      () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
    );
    await expect(page.locator('.pe-edit-fb')).not.toHaveCount(0);
    await expect(page.locator('#pe-edit-warnings li[data-kind="font-fallback"]')).toBeVisible();
    await client.send('Input.insertText', { text: '' }); // a private-use-area glyph absent even from the fallback
    await page.waitForFunction(
      () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
    );
    await expect(page.locator('.pe-edit-missing')).toHaveCount(1);
    await expect(page.locator('#pe-edit-warnings li[data-kind="glyph-missing"]')).toBeVisible();
  });

  test('journal cap (D4, M5 C7): asks journalAdvice after a commit, and if advised shows the save-and-reopen notice', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    const client = await cdp(page);
    const journalEvents = async () =>
      (
        JSON.parse((await page.textContent('#diag-log')) ?? '[]') as {
          event: string;
          data: { advised: boolean; journalBytes: number };
        }[]
      ).filter((e) => e.event === 'journal-advice');

    // 1) Real Worker classification: after a commit the journal holding estimate arrives, and for a small document there is no advice.
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await client.send('Input.insertText', { text: '저널' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    await expect.poll(async () => (await journalEvents()).length).toBe(1);
    const [real] = await journalEvents();
    expect(real!.data.advised).toBe(false);
    expect(real!.data.journalBytes).toBeGreaterThan(0);
    await expect(page.locator('#notice-bar [data-notice="journal"]')).toHaveCount(0);

    // 2) Value injection: if the classification is advised, the notice line shows the advice together with the journal size and warning line.
    await page.evaluate(() => {
      const MIB = 2 ** 20;
      (window as unknown as PeWindow).__pe.pdf.journalAdvice = async () => ({
        advised: true,
        journalBytes: 1600 * MIB,
        incrementBytes: 100 * MIB,
        thresholdBytes: 1536 * MIB,
      });
    });
    await page.mouse.move(1, 1);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await client.send('Input.insertText', { text: '둘째' });
    await page.keyboard.press('Escape');
    const notice = page.locator('#notice-bar [data-notice="journal"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('저장하고 파일을 다시 열면');
    await expect(notice).toContainText('편집 기록 약 1600 MiB');
    await expect(notice).toContainText('경고선 1536 MiB');
    await page.close();
  });

  test('Worker fatal error → recovery → replayEdits result = screen before recovery (D6, A3-3)', async () => {
    // Recovery reapplies only the active log and loses the undo history (contract D6). So after two edits the trap is raised in the render of undo,
    // and we check that the recovery result equals the screen reflecting only the first edit (reapply of a non-empty log).
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    const client = await cdp(page);
    const canvas = () =>
      page.evaluate(() =>
        (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
      );

    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await client.send('Input.insertText', { text: '복구' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    const afterFirst = await canvas();

    // Wait until the page's editable info arrives again after the commit (a double-click before that does not know the target paragraph).
    // If the mouse is already at that spot there is no move event and the border is not refreshed, so move it away and back.
    await page.mouse.move(1, 1);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await client.send('Input.insertText', { text: '둘째' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    expect(await canvas()).not.toBe(afterFirst);

    // Wrap the current Worker handle so that the next renderPage raises a wasm trap (RuntimeError).
    await page.evaluate(() => {
      const handle = (window as unknown as PeWindow).__pe.pdf.current as { api: unknown };
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
    await page.waitForFunction(
      () => (window as unknown as PeWindow).__pe.controller.getState().edit.session === null,
    );
    await expect.poll(canvas, { timeout: 30_000 }).toBe(afterFirst);
  });
  test('recovery checkpoint (D4): save → edit → recovery reapplies only the post-save edits on the saved bytes and shows progress n/N', async () => {
    const page = await open(SAMPLE);
    const client = await cdp(page);
    const canvas = () =>
      page.evaluate(() =>
        (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
      );
    const editOnce = async (text: string) => {
      // A notice line appearing after save pushes the page down, so re-measure the position each time.
      const q = await firstEditable(page);
      await page.mouse.move(1, 1);
      await page.mouse.move(q.x, q.y, { steps: 3 });
      await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
      await page.mouse.dblclick(q.x, q.y);
      await expect(page.locator('#pe-edit-layer')).toBeVisible();
      await client.send('Input.insertText', { text });
      await page.keyboard.press('Escape');
      await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    };
    const pageText = () =>
      page.evaluate(async () => {
        const m = (await (window as unknown as PeWindow).__pe.pdf.extractPage!({
          pageIndex: 0,
        })) as { chars: { text: string }[] };
        return m.chars.map((c) => c.text).join('');
      });
    const diagEvents = async (name: string) =>
      (
        JSON.parse((await page.textContent('#diag-log')) ?? '[]') as {
          event: string;
          data: Record<string, unknown>;
        }[]
      ).filter((e) => e.event === name);

    await editOnce('저장전');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      chooseSave(page, 'save-downloads'),
    ]);
    await download.path();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved');
    // After save, edit the same block twice more and undo the last: active = [1 pre-save, 1 post-save].
    await editOnce('저장뒤');
    const afterSecond = await canvas();
    const textAfterSecond = await pageText();
    await editOnce('셋째');

    // Keep every following progress display (the notice slot changes to the last text).
    await page.evaluate(() => {
      const bar = document.getElementById('notice-bar')!;
      const seen: string[] = [];
      (window as unknown as { __recoverySeen: string[] }).__recoverySeen = seen;
      new MutationObserver(() => {
        const row = bar.querySelector('[data-notice="recovered"]');
        if (row?.textContent) seen.push(row.textContent);
      }).observe(bar, { childList: true, subtree: true, characterData: true });
      const handle = (window as unknown as PeWindow).__pe.pdf.current as { api: unknown };
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
    const notice = page.locator('#notice-bar [data-notice="recovered"]');
    await expect(notice).toContainText('마지막 저장 시점에서 편집 1건 다시 적용', {
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => (window as unknown as PeWindow).__pe.controller.getState().edit.session === null,
    );
    await expect.poll(canvas, { timeout: 30_000 }).toBe(afterSecond);
    // The pre-save edit appears only once (checkpoint + reapply of only post-save edits).
    const text = await pageText();
    expect(text).toBe(textAfterSecond);
    expect(text.split('저장전').length - 1).toBe(1);
    const seen = await page.evaluate(
      () => (window as unknown as { __recoverySeen: string[] }).__recoverySeen,
    );
    expect(seen.some((t) => t.includes('편집 0/1'))).toBe(true);
    expect(seen.some((t) => t.includes('편집 1/1'))).toBe(true);
    const source = await diagEvents('worker-recover-source');
    expect(source.at(-1)?.data).toMatchObject({ fromSavedBaseline: true, replay: 1 });
    await page.close();
  });

  test('B1·9.6 (docs/m3-integration.md section 9): a committed block is one layout paragraph, one overlay box, one hover border', async () => {
    const page = await open(SAMPLE);
    const geo = () =>
      page.evaluate(async () => {
        const pe = (window as unknown as PeWindow).__pe;
        const layout = (await pe.pdf.getPageLayout!(0)) as {
          paragraphs: { id: number; text: string; bbox: number[] }[];
        };
        const box = document.getElementById('pe-page')!.getBoundingClientRect();
        const scale = Number(document.getElementById('pe-page')!.dataset.cssScale);
        return {
          paragraphs: layout.paragraphs.map((p) => ({
            text: p.text,
            x: box.left + ((p.bbox[0]! + p.bbox[2]!) / 2) * scale,
            y: box.top + ((p.bbox[1]! + p.bbox[3]!) / 2) * scale,
            top: box.top + p.bbox[1]! * scale,
            bottom: box.top + p.bbox[3]! * scale,
          })),
        };
      });
    const before = (await geo()).paragraphs;
    const target = before.find((p) => p.text.startsWith('This paragraph'))!;
    // Wait until the edit classification arrives (a double-click before that does not know the target paragraph).
    await page.mouse.move(target.x, target.y, { steps: 3 });
    await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
    await page.mouse.dblclick(target.x, target.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Short line one.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Short line two.');
    await page.waitForFunction(
      () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    // 9.6: with M2 rules alone, the short line after a forced line break is a different paragraph, but with the edit block hint it is one layout paragraph.
    await expect
      .poll(async () =>
        (await geo()).paragraphs.filter((p) => p.text.includes('Short line')).map((p) => p.text),
      )
      .toEqual(['Short line one. Short line two.']);
    const after = (await geo()).paragraphs;
    // One paragraph was replaced by one paragraph (other paragraphs unchanged).
    expect(after).toHaveLength(before.length);
    const block = after.find((p) => p.text.startsWith('Short line'))!;
    const hoverAt = async (x: number, y: number) => {
      await page.mouse.move(1, 1);
      await page.mouse.move(x, y, { steps: 3 });
      const hover = page.locator('#pe-edit-hover');
      await expect(hover).toBeVisible();
      return {
        id: await hover.getAttribute('data-paragraph'),
        box: (await hover.boundingBox())!,
      };
    };
    const y1 = block.top + 0.25 * (block.bottom - block.top);
    const y2 = block.top + 0.75 * (block.bottom - block.top);
    const a = await hoverAt(block.x, y1);
    const b = await hoverAt(block.x, y2);
    expect(b.id).toBe(a.id);
    // One border covers both lines.
    expect(a.box.y).toBeLessThan(y1);
    expect(a.box.y + a.box.height).toBeGreaterThan(y2);
    // Layout overlay: the box count (paragraph count) equals that before the edit (the block is not split into multiple boxes).
    await page.mouse.move(1, 1);
    await page.locator('#pe-overlay-toggle').click();
    const canvas = page.locator('#pe-layout-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-paragraphs', String(before.length));
  });
});
