/**
 * Save flow and notices of the extension viewer (contract 5.8·5.9, D6): injects save classifications and
 * recovery errors through the `?e2e` seam into the real extension, Worker and document (m0-sample.pdf) and checks the dialogs and notices. Flows needing the edit RPC are enabled at integration (docs/m3-viewer-ui.md section 5).
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseSave } from './toolbar-helpers.js';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');

interface Pe {
  pdf: {
    planSave: (r: unknown) => Promise<unknown>;
    save: (r: unknown) => Promise<unknown>;
    listRedactAnnots: () => Promise<unknown>;
  };
}

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-save-'));
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

async function diagEvents(page: Page, name: string): Promise<{ event: string; data: unknown }[]> {
  const log = JSON.parse((await page.textContent('#diag-log')) ?? '[]') as {
    event: string;
    data: unknown;
  }[];
  return log.filter((e) => e.event === name);
}

/** A viewer with a document open (`?e2e`). beforeOpen is a chance to adjust the seam before picking the file. */
async function openViewer(beforeOpen?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
  await expect(page.locator('#open-label')).toBeVisible();
  await page.waitForFunction(() => '__pe' in window);
  await beforeOpen?.(page);
  await page.setInputFiles('#open-file', SAMPLE);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  return page;
}

const plan = (extra: Record<string, unknown>) => ({
  method: 'full',
  options: 'garbage=yes,compress,objstms',
  reason: 'test',
  canBeSavedIncrementally: false,
  heap: {
    inputBytes: 1,
    ratio: 8,
    estimatedPeakBytes: 80,
    limitBytes: 100,
    fraction: 0.8,
    level: 'ok',
    message: null,
  },
  edits: null,
  ...extra,
});

test.describe('supported document size cap (M5 C7, risk 8)', () => {
  test('when the opened document byte count exceeds SUPPORTED_INPUT_BYTES (790 MiB) a notice shows on open, and a small document gets none', async () => {
    const small = await openViewer();
    await expect(small.locator('#notice-bar [data-notice="size"]')).toHaveCount(0);
    await small.close();
    // Value injection: only the open response's byteLength is changed to 800 MiB (the document stays the same).
    const page = await openViewer(async (p) => {
      await p.evaluate(() => {
        const pdf = (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf;
        const real = (pdf.open as (b: ArrayBuffer) => Promise<Record<string, unknown>>).bind(pdf);
        pdf.open = async (b: ArrayBuffer) => ({ ...(await real(b)), byteLength: 800 * 2 ** 20 });
      });
    });
    const notice = page.locator('#notice-bar [data-notice="size"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('지원 크기 790 MiB');
    await expect(notice).toContainText('편집·저장이 실패할 수 있습니다');
    await page.close();
  });

  test('size notice integration (I3): byte-based notice on open → classification ok keeps it, warn replaces the same slot, and the cap appears only once', async () => {
    const page = await openViewer(async (p) => {
      await p.evaluate((okPlan) => {
        const pdf = (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf;
        const real = (pdf.open as (b: ArrayBuffer) => Promise<Record<string, unknown>>).bind(pdf);
        pdf.open = async (b: ArrayBuffer) => ({ ...(await real(b)), byteLength: 800 * 2 ** 20 });
        // The classification right after opening (reportSizeLimit) is ok: the byte-based notice is left as is.
        pdf.planSave = async () => okPlan;
      }, plan({}));
    });
    const rows = page.locator(
      '#notice-bar [data-notice="size"], #notice-bar [data-notice="supported-size"]',
    );
    await expect(rows).toHaveCount(1);
    const notice = page.locator('#notice-bar [data-notice="size"]');
    await expect(notice).toContainText('지원 크기 790 MiB');
    await expect.poll(async () => (await diagEvents(page, 'size-plan')).length).toBe(1);
    await expect(notice).toContainText('지원 크기 790 MiB');

    // Pre-save classification warn: the same slot is replaced by the classification text (still a single notice).
    await page.evaluate(
      (warnPlan) => {
        (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf.planSave =
          async () => warnPlan;
      },
      plan({
        heap: {
          ...plan({}).heap,
          estimatedPeakBytes: 1600 * 2 ** 20,
          limitBytes: 2048 * 2 ** 20,
          level: 'warn',
          message: '큰 문서(테스트)',
        },
      }),
    );
    await chooseSave(page, 'save-downloads');
    const dialog = page.locator('#app-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-dialog-button="cancel"]').click();
    await expect(rows).toHaveCount(1);
    await expect(notice).toContainText(
      '편집·저장이 실패할 수 있습니다(예상 저장 피크 1600 MiB / 한계 2048 MiB)',
    );
    await expect(notice).not.toContainText('790 MiB');
    const text = (await notice.textContent()) ?? '';
    expect(text.split('2048 MiB').length - 1).toBe(1);
    await page.close();
  });
});

test.describe('pre-save classification (5.8)', () => {
  test('over-limit does not save and shows an abort notice', async () => {
    const page = await openViewer();
    await page.evaluate(
      (p) => {
        (window as unknown as { __pe: Pe }).__pe.pdf.planSave = async () => p;
      },
      plan({
        heap: { ...plan({}).heap, level: 'over-limit', message: '메모리 한계를 넘습니다(테스트)' },
      }),
    );
    await chooseSave(page, 'save-downloads');
    const dialog = page.locator('#app-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2')).toHaveText('저장할 수 없습니다');
    await expect(dialog).toContainText('메모리 한계를 넘습니다(테스트)');
    await dialog.locator('[data-dialog-button="ok"]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#status')).toContainText('저장 중단');
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    await page.close();
  });

  test('when over-limit is due to an already grown heap, "그래도 저장 시도" can be chosen (H1)', async () => {
    const page = await openViewer();
    await page.evaluate(
      (p) => {
        (window as unknown as { __pe: Pe }).__pe.pdf.planSave = async () => p;
      },
      plan({
        heap: {
          ...plan({}).heap,
          level: 'over-limit',
          message: '메모리 한계를 넘습니다(테스트)',
          grownHeapBasis: true,
        },
      }),
    );
    const dialog = page.locator('#app-dialog');
    await chooseSave(page, 'save-downloads');
    await expect(dialog.locator('h2')).toHaveText('저장 전 확인');
    await expect(dialog).toContainText('메모리 한계를 넘습니다(테스트)');
    await expect(dialog).toContainText('이미 커진 작업 메모리');
    await expect(dialog.locator('[data-dialog-button="ok"]')).toHaveText('그래도 저장 시도');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.locator('[data-dialog-button="ok"]').click(),
    ]);
    expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
    expect((await diagEvents(page, 'save')).length).toBe(1);
    await page.close();
  });

  test('warn, structure link loss and PDF/A show a confirmation window; cancel does not save, confirm saves', async () => {
    const page = await openViewer();
    await page.evaluate(
      (p) => {
        (window as unknown as { __pe: Pe }).__pe.pdf.planSave = async () => p;
      },
      plan({
        heap: { ...plan({}).heap, level: 'warn', message: '메모리를 많이 씁니다(테스트)' },
        edits: { pages: [0, 2], structureUnlinked: 2, pdfaDeclared: true },
      }),
    );
    const dialog = page.locator('#app-dialog');
    await chooseSave(page, 'save-downloads');
    await expect(dialog.locator('h2')).toHaveText('저장 전 확인');
    await expect(dialog).toContainText('메모리를 많이 씁니다(테스트)');
    await expect(dialog).toContainText('구조(읽기 순서·태그)와의 연결이 끊어집니다');
    await expect(dialog).toContainText('PDF/A');
    await expect(dialog).toContainText('1, 3쪽');
    await dialog.locator('[data-dialog-button="cancel"]').click();
    await expect(dialog).toBeHidden();
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    // Esc also cancels
    await chooseSave(page, 'save-downloads');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    // Confirming saves
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await chooseSave(page, 'save-downloads');
        await dialog.locator('[data-dialog-button="ok"]').click();
      })(),
    ]);
    expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
    expect((await diagEvents(page, 'save')).length).toBe(1);
    await page.close();
  });

  test('saves without a confirmation window when there is no problem', async () => {
    const page = await openViewer();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      chooseSave(page, 'save-downloads'),
    ]);
    expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
    await expect(page.locator('#app-dialog')).toBeHidden();
    const plans = await diagEvents(page, 'save-plan');
    expect(plans).toHaveLength(1);
    expect((plans[0]!.data as { heap: string }).heap).toBe('ok');
    await page.close();
  });
});

test.describe('Worker recovery during save (A3-3)', () => {
  test('on a recovery notice error, asks whether to save again, and saving again succeeds', async () => {
    const page = await openViewer();
    await page.evaluate(() => {
      const pe = (window as unknown as { __pe: Pe }).__pe;
      const real = pe.pdf.save.bind(pe.pdf);
      let first = true;
      pe.pdf.save = async (r) => {
        if (first) {
          first = false;
          const e = new Error('작업 모듈이 중단되어 문서를 복구했습니다');
          e.name = 'WorkerRecoveredError';
          throw e;
        }
        return real(r);
      };
    });
    const dialog = page.locator('#app-dialog');
    await chooseSave(page, 'save-downloads');
    await expect(dialog.locator('h2')).toHaveText('저장하지 못했습니다');
    await expect(dialog).toContainText('다시 저장할까요?');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.locator('[data-dialog-button="ok"]').click(),
    ]);
    expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
    await page.close();
  });

  test('choosing "나중에" does not save', async () => {
    const page = await openViewer();
    await page.evaluate(() => {
      const pe = (window as unknown as { __pe: Pe }).__pe;
      pe.pdf.save = async () => {
        const e = new Error('복구');
        e.name = 'WorkerRecoveredError';
        throw e;
      };
    });
    const dialog = page.locator('#app-dialog');
    await chooseSave(page, 'save-downloads');
    await expect(dialog.locator('h2')).toHaveText('저장하지 못했습니다');
    await dialog.locator('[data-dialog-button="cancel"]').click();
    await expect(dialog).toBeHidden();
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    await page.close();
  });
});

test.describe('notice on open', () => {
  test('Redact annotation report (A2-2): when there is a report, it is shown in the notice line', async () => {
    const page = await openViewer(async (p) => {
      await p.evaluate(() => {
        (window as unknown as { __pe: Pe }).__pe.pdf.listRedactAnnots = async () => ({
          total: 2,
          pages: [0, 3],
        });
      });
    });
    const notice = page.locator('#notice-bar [data-notice="redact"]');
    await expect(notice).toContainText('Redact(가림) 주석 2개');
    await expect(notice).toContainText('1, 4쪽');
    await notice.locator('button').click();
    await expect(page.locator('#notice-bar')).toBeHidden();
    await page.close();
  });

  test('real core report (A2-2): a document without Redact annotations logs total 0 in the diagnostics log without a notice', async () => {
    const page = await openViewer();
    await expect.poll(async () => (await diagEvents(page, 'redact-report')).length).toBe(1);
    expect(await diagEvents(page, 'redact-report-unavailable')).toHaveLength(0);
    await expect(page.locator('#notice-bar')).toBeHidden();
    await page.close();
  });

  test('when the Redact report fails, only a diagnostics log entry is left, without a notice', async () => {
    const page = await openViewer(async (p) => {
      await p.evaluate(() => {
        (window as unknown as { __pe: Pe }).__pe.pdf.listRedactAnnots = async () => {
          throw new Error('보고 실패');
        };
      });
    });
    await expect
      .poll(async () => (await diagEvents(page, 'redact-report-unavailable')).length)
      .toBe(1);
    await expect(page.locator('#notice-bar')).toBeHidden();
    await page.close();
  });
});
