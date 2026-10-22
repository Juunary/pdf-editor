/**
 * 측정 페이지 수동 실행의 탭 메모리 입력(Windows 절차, docs/m5-perf.md 1.3): 작업 관리자 K 값을 그대로 넣으면 MiB 로 바꾸고,
 * 직전과 같은 값·자릿수가 의심스러운 값은 경고 뒤 한 번 더 확인받으며, 결과 JSON 에 원문·단위·경고를 남긴다.
 * 대기는 `?settle=0` 으로 줄인다(작은 문서, 메모리 시나리오만).
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

test('수동 탭 메모리 입력: K 환산·경고 확인·원문 기록', async () => {
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
  // 기준점: 작업 관리자 표시 그대로(쉼표·K).
  await enter('기준점', '272,940K');
  // 종료 직후: 직전과 같은 값 → 경고, 같은 값으로 한 번 더 눌러 넘긴다.
  await enter('종료 직후', '272940');
  await expect(page.locator('#bench-manual-warning')).toContainText('직전 입력과 같은 값');
  await page.click('#bench-continue');
  // 30초 뒤: 0 하나 더 붙은 값 → 자릿수 경고 → 고쳐 넣는다.
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
