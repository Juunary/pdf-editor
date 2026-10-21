/**
 * 메모리 왕복 시나리오 시험(계약 1.1·4.1, 서버). 기준점 = 첫 저장 완료 직후. 이후 50쪽 넘김 왕복·편집 20회·저장 2회를
 * 돌린 뒤 추가 WASM 힙 증가 ≤ 64 MiB, 탭 메모리(렌더러 VmRSS) 증가 ≤ 150 MiB 를 시험으로 고정한다.
 *
 * 기본 문서: 합성 60쪽(fixtures/bench/synth.mjs, 시드 고정). 옵트인: BENCH_CORPUS_DIR 가 있으면 코퍼스 nist-sp800-53r5(492쪽)도 돈다.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO,
  extensionRssMiB,
  launchBenchBrowser,
  openBenchPage,
  serveDocs,
  type BenchDocFile,
} from './bench-harness.js';
import type { BenchResult } from '../src/viewer/bench.js';

test.setTimeout(10 * 60 * 1000);

async function memoryRun(docs: BenchDocFile[]): Promise<BenchResult> {
  const { server, base } = await serveDocs(docs);
  const b = await launchBenchBrowser();
  try {
    const page = await openBenchPage(b);
    await page.exposeFunction('benchTabMemory', () => extensionRssMiB(b.userDataDir));
    return (await page.evaluate(
      (list) => window.__bench.run(list, { scenarios: ['mem'] }),
      docs.map((d) => ({
        id: d.id,
        name: `${d.id}.pdf`,
        url: `${base}/${d.id}.pdf`,
        bytes: d.bytes,
      })),
    )) as unknown as BenchResult;
  } finally {
    await b.close();
    server.close();
  }
}

test('메모리 왕복: 합성 60쪽, 추가 WASM 힙 ≤ 64 MiB · 탭 메모리 ≤ 150 MiB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-editor-bench-mem-'));
  try {
    const path = join(dir, 'mem-60.pdf');
    execFileSync(
      'node',
      [
        'fixtures/bench/synth.mjs',
        '--kind',
        'objects',
        '--pages',
        '60',
        '--objs-per-page',
        '20',
        '--seed',
        '3',
        '--out',
        path,
      ],
      { cwd: REPO, stdio: 'ignore' },
    );
    const result = await memoryRun([{ id: 'mem-60', path, bytes: statSync(path).size, pages: 60 }]);
    const doc = result.docs[0]!;
    expect(doc.errors).toEqual([]);
    const mem = doc.mem!;
    console.log(JSON.stringify(mem));
    expect(mem.navigations).toBeGreaterThanOrEqual(98);
    expect(mem.edits).toBeGreaterThan(0);
    expect(mem.baseline.wasmHeapBytes).not.toBeNull();
    expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
    expect(mem.tabDeltaMiB!).toBeLessThanOrEqual(150);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('메모리 왕복: 코퍼스 nist-sp800-53r5 492쪽(옵트인)', async () => {
  test.skip(!process.env.BENCH_CORPUS_DIR, 'BENCH_CORPUS_DIR 없음');
  const list = JSON.parse(
    execFileSync(
      'node',
      [
        'fixtures/bench/prepare.mjs',
        '--tier',
        'core',
        '--corpus-dir',
        process.env.BENCH_CORPUS_DIR!,
      ],
      { cwd: REPO, maxBuffer: 1 << 24 },
    ).toString(),
  ) as BenchDocFile[];
  const result = await memoryRun(list.filter((d) => d.id === 'nist-sp800-53r5'));
  const mem = result.docs[0]!.mem!;
  console.log(JSON.stringify(mem));
  expect(result.docs[0]!.errors).toEqual([]);
  expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
  expect(mem.tabDeltaMiB!).toBeLessThanOrEqual(150);
});
