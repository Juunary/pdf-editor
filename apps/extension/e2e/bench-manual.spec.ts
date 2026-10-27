/**
 * Tab memory input in the measurement page's manual run (Windows procedure, docs/m5-perf.md 1.3): a Task Manager K value entered as-is is converted to MiB,
 * a value identical to the previous one or with a suspicious digit count gets a warning and must be confirmed once more, and the result JSON keeps the raw text, unit and warnings.
 * Waiting is shortened with `?settle=0` (small document, memory scenario only).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, launchBenchBrowser, type BenchBrowser } from './bench-harness.js';

let b: BenchBrowser;
test.beforeAll(async () => {
  b = await launchBenchBrowser();
});
test.afterAll(async () => {
  await b.close();
});

test('manual tab memory input: K conversion, warning confirmation, raw text recorded', async () => {
  const page = await b.context.newPage();
  await page.goto(`chrome-extension://${b.extensionId}/bench.html?settle=0`);
  await page.setInputFiles('#bench-files', join(DIST, 'diag/m0-sample.pdf'));
  for (const box of await page.locator('[data-scenario]').all()) {
    if ((await box.getAttribute('data-scenario')) !== 'mem') await box.uncheck();
  }
  await page.click('#bench-run');

  const enter = async (label: string, value: string) => {
    await expect(page.locator('#bench-manual')).toBeVisible();
    await expect(page.locator('#bench-manual-label')).toHaveText(label);
    await page.fill('#bench-manual-value', value);
    await page.click('#bench-continue');
  };
  // Checkpoint: exactly as shown in Task Manager (comma, K).
  await enter('기준점', '272,940K');
  // Right after close: same value as the previous one -> warning; press again with the same value to proceed.
  await enter('종료 직후', '272940');
  await expect(page.locator('#bench-manual-warning')).toContainText('직전 입력과 같은 값');
  await page.click('#bench-continue');
  // 30 s later: a value with one extra 0 -> digit-count warning -> correct it.
  await enter('종료 30초 뒤(판정값)', '10007300');
  await expect(page.locator('#bench-manual-warning')).toContainText('5배 이상');
  await page.fill('#bench-manual-value', '1007300');
  await page.click('#bench-continue');

  await expect(page.locator('#bench-status')).toHaveAttribute('data-state', 'done', {
    timeout: 120_000,
  });
  const download = page.waitForEvent('download');
  await page.click('#bench-export');
  const file = await (await download).path();
  const result = JSON.parse(readFileSync(file, 'utf8')) as {
    mode: string;
    docs: {
      mem: {
        tabInputs: {
          label: string;
          raw?: string;
          unit?: string;
          mib: number;
          warnings?: string[];
        }[];
        baseline: { tabMiB: number };
        end: { tabSettledMiB: number };
        tabDeltaMiB: number;
      };
    }[];
  };
  expect(result.mode).toBe('manual');
  const mem = result.docs[0]!.mem;
  expect(mem.tabInputs.map((t) => [t.label, t.raw, t.unit])).toEqual([
    ['baseline', '272,940K', 'K'],
    ['end', '272940', 'K'],
    ['end-settled', '1007300', 'K'],
  ]);
  expect(mem.tabInputs[0]!.warnings).toEqual([]);
  expect(mem.tabInputs[1]!.warnings).toEqual(['직전 입력과 같은 값입니다(새로 읽은 값인지 확인)']);
  expect(mem.baseline.tabMiB).toBeCloseTo(272940 / 1024, 6);
  expect(mem.end.tabSettledMiB).toBeCloseTo(1007300 / 1024, 6);
  expect(mem.tabDeltaMiB).toBeCloseTo((1007300 - 272940) / 1024, 6);
});
