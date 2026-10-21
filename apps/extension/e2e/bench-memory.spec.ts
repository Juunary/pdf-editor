/**
 * 메모리 왕복 회귀 감시(합성 60쪽, 서버). 계약 1.1 의 메모리 시나리오(기준점 = 첫 저장 완료 직후, 이후 50쪽 넘김 왕복·
 * 편집 20회·저장 2회)를 작은 합성 문서로 돌려 누수·급증을 잡는다. DoD 판정 시험이 아니다: DoD 는 Windows 기준 PC 의
 * 측정 페이지 결과로 판정하고(계약 D1), 서버 실제 문서 값은 docs/m5-perf.md 에 기록한다.
 *
 * 단언: 추가 WASM 힙 ≤ 64 MiB, 탭 메모리(렌더러 VmRSS) 증가 강제 GC 뒤 ≤ 150 MiB, 종료 직후 ≤ 250 MiB(넉넉한 상한,
 * 수거 전 JS 쓰레기 때문에 96–183 MiB 로 흔들린 값, docs/m5-integration.md 4.2).
 *
 * 기본 문서: 합성 60쪽(fixtures/bench/synth.mjs, 시드 고정). 옵트인: BENCH_CORPUS_DIR 가 있으면 코퍼스 nist-sp800-53r5(492쪽)도 돈다.
 */

/** 종료 직후 탭 메모리 증가 상한(MiB). 강제 GC 전 값이라 넉넉하게 둔다. */
const TAB_DELTA_RAW_CAP_MIB = 250;
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO,
  exposeTabMemory,
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
    await exposeTabMemory(b, page);
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

test('메모리 왕복 회귀 감시(합성 60쪽): 추가 WASM 힙 ≤ 64 MiB · 탭 메모리 GC 뒤 ≤ 150 MiB · 종료 직후 ≤ 250 MiB', async () => {
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
    // 탭 메모리는 강제 GC 뒤 값으로 150 MiB 를 단언한다. 종료 직후 값(tabDeltaMiB)은 수거 전 JS 쓰레기 양(종료 시 JS 힙
    // 36–109 MiB)에 따라 96–183 MiB 로 흔들려 간헐 실패했다(docs/m5-integration.md 4.2). 종료 직후 값에는 넉넉한 상한만 둔다.
    expect(mem.tabDeltaAfterGcMiB).not.toBeNull();
    expect(mem.tabDeltaAfterGcMiB!).toBeLessThanOrEqual(150);
    expect(mem.tabDeltaMiB).not.toBeNull();
    expect(mem.tabDeltaMiB!).toBeLessThanOrEqual(TAB_DELTA_RAW_CAP_MIB);
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
  // 실제 문서의 탭 메모리는 값을 기록만 한다(docs/m5-perf.md 3.3: 서버 VmRSS 는 수거 가능한 쓰레기를 포함).
  expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
});
