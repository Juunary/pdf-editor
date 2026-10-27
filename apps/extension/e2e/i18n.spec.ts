/**
 * Header language (user request 2026-10-23): Korean if the browser UI language (`chrome.i18n.getUILanguage()`) is a ko variant, English otherwise.
 * Checks that with the English locale (en-US) and another language (ja-JP) the toolbar, find bar, save menu, status line, notice line, and about and save-confirmation dialogs are in English,
 * and that the Korean locale gives Korean. The locale is Playwright `locale` (Linux Chromium ignores `--lang`, e2e/locale.ts).
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

interface Env {
  context: BrowserContext;
  extensionId: string;
}

/**
 * Passing language also changes Chromium's app language (environment variable LANGUAGE). Extension messages (`_locales`, chrome.i18n.getMessage, manifest
 * name and description) follow this language, and Playwright `locale` is not reflected (measured, Linux Chromium).
 */
async function withLocale(
  locale: string,
  fn: (env: Env) => Promise<void>,
  language?: string,
): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-i18n-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale,
    ...(language ? { env: { ...process.env, LANGUAGE: language } } : {}),
    acceptDownloads: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await fn({ context, extensionId: new URL(sw.url()).host });
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** A viewer with a document open (`?e2e`, no FSA picker → saving goes through chrome.downloads). beforeOpen is a hook to adjust the seam before picking the file. */
async function openViewer(
  env: Env,
  width = 1280,
  beforeOpen?: (page: Page) => Promise<void>,
): Promise<Page> {
  const page = await env.context.newPage();
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.goto(`chrome-extension://${env.extensionId}/viewer.html?e2e`);
  await page.waitForFunction(() => '__pe' in window);
  await beforeOpen?.(page);
  await page.setInputFiles('#open-file', SAMPLE);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  await expect(page.locator('#pe-doc-undo')).toBeVisible();
  return page;
}

/** Visible text and title, aria-label and placeholder of the header area (toolbar, notice line, find bar, save menu). */
function headerTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const root of [
      document.getElementById('toolbar'),
      document.getElementById('notice-bar'),
    ]) {
      if (!root) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (el && el.getClientRects().length > 0 && n.textContent!.trim() !== '') {
          out.push(n.textContent!.trim());
        }
      }
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        if (el.getClientRects().length === 0) continue;
        for (const a of ['title', 'aria-label', 'placeholder']) {
          const v = el.getAttribute(a);
          if (v) out.push(v);
        }
      }
    }
    return out;
  });
}

const plan = (heap: Record<string, unknown>) => ({
  method: 'full',
  options: 'garbage=yes,compress,objstms',
  reason: 'test',
  canBeSavedIncrementally: false,
  heap: {
    inputBytes: 100 * 2 ** 20,
    ratio: 8,
    estimatedPeakBytes: 1600 * 2 ** 20,
    limitBytes: 2048 * 2 ** 20,
    fraction: 0.78,
    level: 'ok',
    // The core heap message is Korean. The English screen builds its text from the numbers instead of this message.
    message: '예상 피크 WASM 힙 1600 MiB 가 상한 2048 MiB 의 78% 입니다.',
    ...heap,
  },
  edits: null,
});

test('English locale (en-US): toolbar, find bar, save menu and page arrows are in English, and the header area has no Hangul', async () => {
  await withLocale('en-US', async (env) => {
    const page = await openViewer(env);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#pe-controls')).toHaveAttribute('aria-label', 'Page navigation');
    await expect(page.locator('#pe-prev')).toHaveAttribute('aria-label', 'Previous page');
    await expect(page.locator('#pe-next')).toHaveAttribute('aria-label', 'Next page');
    await expect(page.locator('#pe-page-input')).toHaveAttribute('aria-label', 'Page number');
    await expect(page.locator('#pe-page-count')).toHaveText('/ 1');
    await expect(page.locator('#pe-find-toggle')).toHaveText('Find');
    await expect(page.locator('#pe-find-toggle')).toHaveAttribute(
      'title',
      'Find in document (Ctrl+F)',
    );
    await expect(page.locator('#pe-overlay-toggle')).toHaveText('Layout & editable marks');
    await expect(page.locator('#pe-doc-undo')).toHaveText('Undo');
    await expect(page.locator('#pe-doc-redo')).toHaveText('Redo');
    await expect(page.locator('#pe-fb-toggle')).toHaveText('Show fallback');
    await expect(page.locator('label.pe-edit-opt')).toHaveText('Block tagged PDF edits');
    await expect(page.locator('#save-menu-button')).toHaveAttribute('aria-label', 'Save');
    await expect(page.locator('#save-menu-button')).toHaveAttribute('title', 'Save');
    await expect(page.locator('#about')).toHaveText('About');
    await expect(page.locator('#open-label')).toContainText('Open PDF');
    await expect(page.locator('#pe-arrow-prev')).toHaveAttribute('aria-label', 'Previous page');
    await expect(page.locator('#pe-arrow-next')).toHaveAttribute('aria-label', 'Next page');

    // Save menu (two items when the diagnostics display is off)
    await page.click('#save-menu-button');
    await expect(page.locator('#save')).toHaveText(/^\s*Save\s*Ctrl\+S\s*$/);
    await expect(page.locator('#save-as')).toHaveText('Save as');
    await expect(page.locator('#save-downloads')).toBeHidden();
    for (const s of await headerTexts(page)) expect(s, '저장 메뉴').not.toMatch(HANGUL);
    await page.keyboard.press('Escape');

    // Find bar: no results, previous/next, case sensitivity, close
    await page.keyboard.press('Control+f');
    await expect(page.locator('#pe-find-input')).toHaveAttribute('placeholder', 'Find in document');
    await page.locator('#pe-find-input').fill('zzqqxx');
    await expect(page.locator('#pe-find-count')).toHaveText('No results');
    await expect(page.locator('#pe-find-prev')).toHaveAttribute('aria-label', 'Previous match');
    await expect(page.locator('#pe-find-next')).toHaveAttribute('aria-label', 'Next match');
    await expect(page.locator('#pe-find-case')).toHaveAttribute('aria-label', 'Match case');
    await expect(page.locator('#pe-find-close')).toHaveAttribute('aria-label', 'Close find bar');
    for (const s of await headerTexts(page)) expect(s, '툴바·검색창').not.toMatch(HANGUL);
    await page.close();
  });
});

test('English locale: notice line, status line, save confirmation and about dialog are in English', async () => {
  await withLocale('en-US', async (env) => {
    // Notice line: size notice (opened bytes 800 MiB), Redact report
    const page = await openViewer(env, 1280, async (p) => {
      await p.evaluate(() => {
        const pdf = (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf;
        const real = (pdf.open as (b: ArrayBuffer) => Promise<Record<string, unknown>>).bind(pdf);
        pdf.open = async (b: ArrayBuffer) => ({ ...(await real(b)), byteLength: 800 * 2 ** 20 });
        pdf.listRedactAnnots = async () => ({ total: 2, pages: [0, 3] });
      });
    });
    const size = page.locator('#notice-bar [data-notice="size"]');
    await expect(size).toContainText('exceeds the supported size of 790 MiB');
    const redact = page.locator('#notice-bar [data-notice="redact"]');
    await expect(redact).toContainText('2 unapplied Redact annotation(s) (page 1, 4)');
    await expect(redact.locator('button')).toHaveAttribute('title', 'Close');
    for (const s of await headerTexts(page)) expect(s, '알림 줄').not.toMatch(HANGUL);

    // Save confirmation dialog (warn): English text instead of the core Korean text, buttons Cancel and Save
    await page.evaluate(
      (p) => {
        (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf.planSave =
          async () => p;
      },
      plan({ level: 'warn' }),
    );
    await page.click('#save-menu-button');
    await page.click('#save');
    const dialog = page.locator('#app-dialog');
    await expect(dialog.locator('h2')).toHaveText('Before saving');
    await expect(dialog).toContainText('Saving is expected to use a lot of memory');
    await expect(dialog.locator('[data-dialog-button="cancel"]')).toHaveText('Cancel');
    await expect(dialog.locator('[data-dialog-button="ok"]')).toHaveText('Save');
    expect(await dialog.textContent()).not.toMatch(HANGUL);
    await dialog.locator('[data-dialog-button="cancel"]').click();
    await expect(page.locator('#status')).toHaveText('Save cancelled');

    // Save (no FSA → download): status line "Saved: Downloads"
    await page.evaluate((p) => {
      (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf.planSave =
        async () => p;
    }, plan({}));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    await download.path();
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved');
    await expect(page.locator('#status')).toHaveText('Saved: Downloads');

    // About dialog
    await page.click('#about');
    await expect(dialog.locator('h2')).toHaveText('About PDF Editor');
    await expect(dialog).toContainText('Version ');
    await expect(dialog.locator('a').first()).toContainText('Source code (v');
    await expect(dialog.locator('[data-dialog-button="ok"]')).toHaveText('Close');
    expect(await dialog.textContent()).not.toMatch(HANGUL);
    await page.close();
  });
});

test('other languages (ja-JP) give English, the Korean locale (ko-KR) gives Korean', async () => {
  await withLocale('ja-JP', async (env) => {
    const page = await openViewer(env);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#pe-find-toggle')).toHaveText('Find');
    await page.close();
  });
  await withLocale('ko-KR', async (env) => {
    const page = await openViewer(env);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('#pe-find-toggle')).toHaveText('찾기');
    await expect(page.locator('#pe-overlay-toggle')).toHaveText('레이아웃·편집 표시');
    await expect(page.locator('#about')).toHaveText('정보');
    await page.click('#save-menu-button');
    await expect(page.locator('#save-as')).toHaveText('다른 이름으로 저장');
    await page.close();
  });
});

test('extension name, description and toolbar title (_locales, user decision 2026-10-26): ko is Korean, en and ja are English (default en)', async () => {
  const cases = [
    { locale: 'ko-KR', language: 'ko', ko: true },
    { locale: 'en-US', language: 'en_US', ko: false },
    { locale: 'ja-JP', language: 'ja', ko: false },
  ];
  for (const c of cases) {
    await withLocale(
      c.locale,
      async (env) => {
        const sw = env.context.serviceWorkers()[0]!;
        const m = await sw.evaluate(() => {
          const manifest = chrome.runtime.getManifest();
          return {
            name: manifest.name,
            description: manifest.description ?? '',
            title: manifest.action?.default_title ?? '',
            uiLanguage: chrome.i18n.getUILanguage(),
          };
        });
        // The development build (dist) has " (dev)" appended to the name (the store build is in release-smoke.spec.ts).
        expect(m.name, c.language).toBe('PDF Editor (dev)');
        if (c.ko) {
          expect(m.description).toBe(
            'Chrome 에서 PDF 를 열어 글자 선택·검색, 문단·표 셀·도형 편집, 저장까지 기기 안에서 처리합니다.',
          );
          expect(m.title).toBe('PDF Editor 뷰어 열기');
        } else {
          expect(m.description).toBe(
            'Open PDFs in Chrome to select, search, edit paragraphs, table cells and shapes, and save. All local.',
          );
          expect(m.title).toBe('Open PDF Editor viewer');
        }
        expect([...m.description].length).toBeLessThanOrEqual(132);
      },
      c.language,
    );
  }
});

// ── Page editing UI and edit restriction reasons (user decision 2026-10-26) ──────

/**
 * 1-page PDF: one line of text (editable), text rotated 90° (vertical-or-rotated), a filled rectangle (editable path), a fill that doubles as a clip
 * (clip-path). Coordinates are in PDF space (origin at the bottom).
 */
function editUiPdf(): Buffer {
  const content =
    'BT /F1 14 Tf 100 750 Td (Editable sample line) Tj ET\n' +
    'BT /F1 16 Tf 0 1 -1 0 520 500 Tm (Rotated words here) Tj ET\n' +
    '1 0 0 rg 100 600 200 100 re f\n' +
    'q 0 0 1 rg 100 400 200 100 re W f Q\n';
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

/** Page space (pt, origin at the top) → screen coordinates. */
function pageAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.getElementById('pe-page')!;
      const box = el.getBoundingClientRect();
      const s = Number(el.dataset.cssScale);
      return { x: box.left + px! * s, y: box.top + py! * s };
    },
    [x, y] as const,
  );
}

async function openEditUiPdf(env: Env): Promise<Page> {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-i18n-pdf-'));
  const file = join(dir, 'edit-ui.pdf');
  writeFileSync(file, editUiPdf());
  const page = await env.context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${env.extensionId}/viewer.html?e2e`);
  await page.waitForFunction(() => '__pe' in window);
  await page.setInputFiles('#open-file', file);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
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

/** Visible text and title, aria-label of an element. */
function visibleTexts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent!.trim() !== '') out.push(n.textContent!.trim());
    }
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      for (const a of ['title', 'aria-label']) {
        const v = el.getAttribute(a);
        if (v) out.push(v);
      }
    }
    return out;
  }, selector);
}

test('English locale: non-editable popover, restriction reasons, path panel, editability overlay legend and tooltips are in English', async () => {
  await withLocale('en-US', async (env) => {
    const page = await openEditUiPdf(env);

    // Editability overlay legend (together with the layout)
    await page.click('#pe-overlay-toggle');
    const legend = page.locator('#pe-marks-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('Editable');
    await expect(legend).toContainText('Restricted (dotted)');
    await expect(legend).toContainText('Thick line = paragraph or table cell, thin line = path');
    for (const s of await visibleTexts(page, '#pe-marks-legend')) expect(s).not.toMatch(HANGUL);

    // Tooltip over rotated text: kind and reason in English
    const rotated = await pageAt(page, 513, 220);
    await page.mouse.move(rotated.x, rotated.y);
    const tip = page.locator('#pe-mark-tip');
    await expect(tip).toHaveText(/^Paragraph · Restricted: /);
    await expect(tip).toContainText('Vertical or rotated text cannot be edited.');
    await page.click('#pe-overlay-toggle'); // turn it off and enter editing

    // Non-editable popover (core classification vertical-or-rotated → English reason)
    await page.mouse.dblclick(rotated.x, rotated.y);
    const pop = page.locator('#pe-edit-popover');
    await expect(pop).toBeVisible();
    await expect(pop.locator('strong')).toHaveText('This paragraph cannot be edited');
    await expect(pop.locator('li')).toHaveText(['Vertical or rotated text cannot be edited.']);
    await expect(pop.locator('#pe-edit-popover-close')).toHaveText('Close');
    for (const s of await visibleTexts(page, '#pe-edit-popover')) expect(s).not.toMatch(HANGUL);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);

    // Path panel: editable filled rectangle (Alt+click)
    const altSelect = async (x: number, y: number, panelText: RegExp) => {
      await expect(async () => {
        const p = await pageAt(page, x, y);
        await page.keyboard.down('Alt');
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up('Alt');
        await expect(page.locator('#pe-path-panel')).toContainText(panelText, { timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
    };
    await altSelect(200, 142, /Fill color/);
    const panel = page.locator('#pe-path-panel');
    await expect(panel.locator('strong')).toHaveText('1 path selected');
    await expect(panel).toContainText('Stroke color');
    await expect(panel).toContainText('Line width (pt)');
    await expect(page.locator('#pe-path-points')).toHaveText('Edit points');
    await expect(page.locator('#pe-path-delete')).toHaveText('Delete');
    await expect(page.locator('#pe-path-delete')).toHaveAttribute(
      'title',
      'Delete the selected paths (Delete)',
    );
    await expect(page.locator('#pe-path-clear')).toHaveText('Clear selection');
    for (const s of await visibleTexts(page, '#pe-path-panel')) expect(s).not.toMatch(HANGUL);

    // Fill that doubles as a clip: restriction reason in English (reason code text instead of the core Korean description)
    await page.click('#pe-path-clear');
    await altSelect(200, 342, /clipping area/);
    await expect(page.locator('#pe-path-note li')).toHaveText([
      'A path that defines a clipping area cannot be edited.',
    ]);
    for (const s of await visibleTexts(page, '#pe-path-panel')) expect(s).not.toMatch(HANGUL);
    await page.click('#pe-path-clear');

    // In-editor guidance (edit-page record notice and input names)
    const line = await pageAt(page, 150, 37);
    await page.mouse.dblclick(line.x, line.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await expect(page.locator('#pe-edit-input')).toHaveAttribute('aria-label', 'Paragraph editor');
    await expect(page.locator('#pe-edit-info')).toContainText(
      'Saving records the edited page numbers in the file info (PdfEditorEdits).',
    );
    for (const s of await visibleTexts(page, '#pe-edit-layer')) expect(s).not.toMatch(HANGUL);
    await page.click('#pe-edit-cancel');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    await page.close();
  });
});
