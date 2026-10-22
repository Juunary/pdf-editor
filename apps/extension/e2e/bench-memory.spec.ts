/**
 * 메모리 왕복 회귀 감시(합성 60쪽, 서버). 계약 1.1 의 메모리 시나리오(기준점 = 첫 저장 완료 직후, 이후 50쪽 넘김 왕복·
 * 편집 20회·저장 2회)를 작은 합성 문서로 돌려 누수·급증을 잡는다. DoD 판정 시험이 아니다: DoD 는 Windows 기준 PC 의
 * 측정 페이지 결과로 판정하고(계약 D1), 서버 실제 문서 값은 docs/m5-perf.md 에 기록한다.
 *
 * 끝 측정 시점(계약 D1·4.1, 사용자 결정 2026-10-21): WASM 은 MuPDF 캐시를 비운(`emptyStore`) 뒤 사용 중 힙, 탭은 30 s 대기
 * 뒤 렌더러 VmRSS. 단언: 이 두 판정값이 각각 ≤ 64 MiB·≤ 150 MiB. 대기 전 탭 증가에는 넉넉한 상한(250 MiB)만 둔다.
 *
 * 기본 문서: 합성 60쪽(fixtures/bench/synth.mjs, 시드 고정). 옵트인: BENCH_CORPUS_DIR 가 있으면 코퍼스 nist-sp800-53r5(492쪽)도 돈다.
 *
 * 큰 쪽 콘텐츠 회귀(Windows 확인 W2, docs/m5-followup.md 5.1): 편집이 풀린 채 다시 쓴 쪽 콘텐츠를 저널이 편집마다 보관하던 경로.
 * 기본 e2e 는 합성 축소 사례(풀린 8 MiB 쪽의 문단 10건), 옵트인은 Windows 와 같은 코퍼스 kogl-mods-cpi-202609 시나리오다.
 * 두 시험 모두 판정값(WASM `emptyStore` 뒤 사용 중 힙 증가) ≤ 64 MiB 를 단언한다(탭 메모리는 기록만).
 */

/** 대기 전 탭 메모리 증가 상한(MiB). 수거 전 JS 쓰레기 때문에 흔들리므로 넉넉하게 둔다. */
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
import type { BenchOptions } from '../src/viewer/bench-run.js';

const MiB = 2 ** 20;

test.setTimeout(10 * 60 * 1000);

async function memoryRun(
  docs: BenchDocFile[],
  options: Partial<BenchOptions> = {},
): Promise<BenchResult> {
  const { server, base } = await serveDocs(docs);
  const b = await launchBenchBrowser();
  try {
    const page = await openBenchPage(b);
    await exposeTabMemory(b, page);
    return (await page.evaluate(
      ([list, opts]) => window.__bench.run(list, { ...(opts as object), scenarios: ['mem'] }),
      [
        docs.map((d) => ({
          id: d.id,
          name: `${d.id}.pdf`,
          url: `${base}/${d.id}.pdf`,
          bytes: d.bytes,
        })),
        options,
      ] as const,
    )) as unknown as BenchResult;
  } finally {
    await b.close();
    server.close();
  }
}

test('메모리 왕복 회귀 감시(합성 60쪽): emptyStore 뒤 WASM 사용 중 힙 증가 ≤ 64 MiB · 30 s 뒤 탭 증가 ≤ 150 MiB', async () => {
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
    expect(mem.settleMs).toBe(30_000);
    expect(mem.baseline.wasmUsedBytes).not.toBeNull();
    expect(mem.wasmHeapDeltaMiB).not.toBeNull();
    expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
    expect(mem.wasmLinearDeltaMiB).not.toBeNull();
    expect(mem.tabDeltaMiB).not.toBeNull();
    expect(mem.tabDeltaMiB!).toBeLessThanOrEqual(150);
    expect(mem.tabDeltaBeforeWaitMiB).not.toBeNull();
    expect(mem.tabDeltaBeforeWaitMiB!).toBeLessThanOrEqual(TAB_DELTA_RAW_CAP_MIB);
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
  // 실제 문서의 탭 메모리는 값을 기록만 한다(docs/m5-perf.md 3.3).
  expect(mem.wasmHeapDeltaMiB).not.toBeNull();
  expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
});

test('큰 쪽 콘텐츠 회귀(합성, 풀린 8 MiB 쪽의 문단 10건 첫 편집): WASM 사용 중 힙 증가 ≤ 64 MiB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-editor-bench-heavy-'));
  try {
    const path = join(dir, 'heavy-3.pdf');
    execFileSync(
      'node',
      ['fixtures/bench/synth.mjs', '--kind', 'heavy', '--pages', '3', '--seed', '4', '--out', path],
      { cwd: REPO, stdio: 'ignore' },
    );
    const result = await memoryRun(
      [{ id: 'heavy-3', path, bytes: statSync(path).size, pages: 3 }],
      {
        mem: { pages: 3, edits: 10, saves: 2, settleMs: 0 },
      },
    );
    const doc = result.docs[0]!;
    expect(doc.errors).toEqual([]);
    const mem = doc.mem!;
    console.log(
      JSON.stringify({
        wasmHeapDeltaMiB: mem.wasmHeapDeltaMiB,
        wasmLinearDeltaMiB: mem.wasmLinearDeltaMiB,
        journalMiB: (mem.editLog.at(-1)?.journalBytes ?? 0) / MiB,
        tabDeltaMiB: mem.tabDeltaMiB,
      }),
    );
    // 시나리오가 의도한 경로를 탔는지: 큰 쪽(0쪽) 문단 10건을 모두 처음 고쳤다(블록 재편집 아님).
    const committed = mem.editLog.filter((e) => e.committed);
    expect(committed).toHaveLength(10);
    expect(committed.every((e) => e.pageIndex === 0 && e.editedBlock === false)).toBe(true);
    // 저널 보유 추정: 풀린 콘텐츠(8 MiB) × 10 이 아니라 압축 크기(약 1.7 MiB) 몫.
    expect(committed.at(-1)!.journalBytes!).toBeLessThan(32 * MiB);
    expect(mem.wasmHeapDeltaMiB).not.toBeNull();
    expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('메모리 왕복: 코퍼스 kogl-mods-cpi-202609(옵트인, Windows W2 와 같은 시나리오)', async () => {
  test.skip(!process.env.BENCH_CORPUS_DIR, 'BENCH_CORPUS_DIR 없음');
  test.setTimeout(20 * 60 * 1000);
  const list = JSON.parse(
    execFileSync(
      'node',
      [
        'fixtures/bench/prepare.mjs',
        '--tier',
        'judge-stress',
        '--corpus-dir',
        process.env.BENCH_CORPUS_DIR!,
      ],
      { cwd: REPO, maxBuffer: 1 << 24 },
    ).toString(),
  ) as BenchDocFile[];
  const result = await memoryRun(list.filter((d) => d.id === 'kogl-mods-cpi-202609'));
  const mem = result.docs[0]!.mem!;
  console.log(
    JSON.stringify({
      wasmHeapDeltaMiB: mem.wasmHeapDeltaMiB,
      wasmLinearDeltaMiB: mem.wasmLinearDeltaMiB,
      journalMiB: (mem.editLog.at(-1)?.journalBytes ?? 0) / MiB,
      tabDeltaMiB: mem.tabDeltaMiB,
    }),
  );
  expect(result.docs[0]!.errors).toEqual([]);
  expect(mem.edits).toBe(20);
  expect(mem.wasmHeapDeltaMiB).not.toBeNull();
  expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
});
