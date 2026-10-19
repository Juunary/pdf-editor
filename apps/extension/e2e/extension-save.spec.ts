/**
 * 확장 뷰어의 저장 흐름·알림(계약 5.8·5.9, D6): 실제 확장·Worker·문서(m0-sample.pdf)에 `?e2e` 이음매로 저장 판정과
 * 복구 오류를 주입해 대화상자·알림을 확인한다. 편집 RPC 가 필요한 흐름은 통합 때 켠다(docs/m3-viewer-ui.md 5절).
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    await page.click('#save-downloads');
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
    await page.click('#save-downloads');
    await expect(dialog.locator('h2')).toHaveText('저장 전 확인');
    await expect(dialog).toContainText('메모리를 많이 씁니다(테스트)');
    await expect(dialog).toContainText('구조(읽기 순서·태그)와의 연결이 끊어집니다');
    await expect(dialog).toContainText('PDF/A');
    await expect(dialog).toContainText('1, 3쪽');
    await dialog.locator('[data-dialog-button="cancel"]').click();
    await expect(dialog).toBeHidden();
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    // Esc 도 취소
    await page.click('#save-downloads');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await diagEvents(page, 'save')).toHaveLength(0);
    // 확인하면 저장한다
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.click('#save-downloads');
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
      page.click('#save-downloads'),
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
    await page.click('#save-downloads');
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
    await page.click('#save-downloads');
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

  test('core 에 Redact 보고 RPC 가 없으면 알림 없이 진단 로그만 남긴다', async () => {
    const page = await openViewer();
    await expect
      .poll(async () => (await diagEvents(page, 'redact-report-unavailable')).length)
      .toBe(1);
    await expect(page.locator('#notice-bar')).toBeHidden();
    await page.close();
  });

  test('M3 편집 RPC 가 "미구현" 인 동안: 편집만 꺼지고 렌더·저장은 유지된다', async () => {
    const page = await openViewer();
    // core 가 편집 RPC 를 구현하면(통합 후) 이 시험은 스스로 건너뛴다.
    const unavailable = await page.evaluate(
      () => document.querySelector('#pe-notice')?.textContent ?? '',
    );
    test.skip(!unavailable.includes('문단 편집'), 'core 편집 RPC 구현됨 — 통합 e2e 로 대체');
    await expect(page.locator('#pe-notice')).toContainText('문단 편집');
    await expect(page.locator('#pe-doc-undo')).toHaveCount(0);
    expect((await diagEvents(page, 'edit-unavailable')).length).toBe(1);
    await expect(page.locator('#save')).toBeEnabled();
    await page.close();
  });
});
