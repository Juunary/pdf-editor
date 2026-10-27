/**
 * 확장 뷰어의 저장 흐름·알림(계약 5.8·5.9, D6): 실제 확장·Worker·문서(m0-sample.pdf)에 `?e2e` 이음매로 저장 판정과
 * 복구 오류를 주입해 대화상자·알림을 확인한다. 편집 RPC 가 필요한 흐름은 통합 때 켠다(docs/m3-viewer-ui.md 5절).
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

/** 문서를 연 뷰어(`?e2e`). beforeOpen 은 파일을 고르기 전에 이음매를 손볼 기회다. */
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

test.describe('지원 문서 크기 상한(M5 C7, 리스크 8)', () => {
  test('열린 문서 바이트 수가 SUPPORTED_INPUT_BYTES(790 MiB)를 넘으면 열 때 알리고, 작은 문서는 알리지 않는다', async () => {
    const small = await openViewer();
    await expect(small.locator('#notice-bar [data-notice="size"]')).toHaveCount(0);
    await small.close();
    // 값 주입: open 응답의 byteLength 만 800 MiB 로 바꾼다(문서는 그대로).
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

  test('크기 알림 통합(I3): 열 때 바이트 기준 안내 → 판정 ok 는 유지, warn 이면 같은 칸을 바꾸고 상한은 한 번만', async () => {
    const page = await openViewer(async (p) => {
      await p.evaluate((okPlan) => {
        const pdf = (window as unknown as { __pe: { pdf: Record<string, unknown> } }).__pe.pdf;
        const real = (pdf.open as (b: ArrayBuffer) => Promise<Record<string, unknown>>).bind(pdf);
        pdf.open = async (b: ArrayBuffer) => ({ ...(await real(b)), byteLength: 800 * 2 ** 20 });
        // 열기 직후 판정(reportSizeLimit)은 ok: 바이트 기준 안내를 그대로 둔다.
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

    // 저장 전 판정 warn: 같은 칸이 판정 문구로 바뀐다(알림은 여전히 하나).
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

test.describe('저장 전 판정(5.8)', () => {
  test('over-limit 은 저장하지 않고 중단 안내를 보인다', async () => {
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

  test('over-limit 근거가 이미 커진 힙이면 "그래도 저장 시도" 를 고를 수 있다(H1)', async () => {
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

  test('warn·구조 연결 끊김·PDF/A 는 확인 창, 취소하면 저장하지 않고 확인하면 저장한다', async () => {
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
    // Esc 도 취소
    await chooseSave(page, 'save-downloads');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    // 확인하면 저장한다
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

  test('문제 없으면 확인 창 없이 저장한다', async () => {
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

test.describe('저장 중 Worker 복구(A3-3)', () => {
  test('복구 알림 오류를 받으면 다시 저장할지 묻고, 다시 저장하면 저장된다', async () => {
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

  test('"나중에" 를 고르면 저장하지 않는다', async () => {
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

test.describe('열기 시 알림', () => {
  test('Redact 주석 보고(A2-2): 보고가 있으면 알림 줄에 표시한다', async () => {
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

  test('실제 core 보고(A2-2): Redact 주석이 없는 문서는 알림 없이 진단 로그에 total 0', async () => {
    const page = await openViewer();
    await expect.poll(async () => (await diagEvents(page, 'redact-report')).length).toBe(1);
    expect(await diagEvents(page, 'redact-report-unavailable')).toHaveLength(0);
    await expect(page.locator('#notice-bar')).toBeHidden();
    await page.close();
  });

  test('Redact 보고가 실패하면 알림 없이 진단 로그만 남긴다', async () => {
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
