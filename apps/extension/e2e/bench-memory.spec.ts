/**
 * Memory round-trip regression watch (synthetic 60 pages, server). Runs the contract 1.1 memory scenario (checkpoint = right after the first save completes, then a 50-page flip round trip,
 * 20 edits, 2 saves) on a small synthetic document to catch leaks and spikes. This is not the DoD classification test: the DoD is decided from the measurement page results on the Windows reference PC
 * (contract D1), and server real-document values are recorded in docs/m5-perf.md.
 *
 * End measurement point (contract D1·4.1, user decision 2026-10-21): WASM is the in-use heap after clearing the MuPDF cache (`emptyStore`); the tab is the renderer VmRSS after a 30 s wait.
 * Assertions: these two classification values are each ≤ 64 MiB and ≤ 150 MiB. Only a generous cap (250 MiB) is set on the tab increase before the wait.
 *
 * Default document: synthetic 60 pages (fixtures/bench/synth.mjs, fixed seed). Opt-in: if BENCH_CORPUS_DIR is set, the corpus nist-sp800-53r5 (492 pages) also runs.
 *
 * Large page content regression (Windows check W2, docs/m5-followup.md 5.1): the path where the journal kept the inflated page content rewritten with editing unlocked, once per edit.
 * The default e2e is a synthetic reduced case (10 paragraphs on an inflated 8 MiB page); the opt-in one is the same scenario as Windows with the corpus kogl-mods-cpi-202609.
 * Both tests assert the classification value (WASM in-use heap increase after `emptyStore`) ≤ 64 MiB (tab memory is only recorded).
 */

/** Cap on the tab memory increase before the wait (MiB). It fluctuates because of uncollected JS garbage, so it is set generously. */
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

test('memory round-trip regression watch (synthetic 60 pages): WASM in-use heap increase after emptyStore ≤ 64 MiB · tab increase after 30 s ≤ 150 MiB', async () => {
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

test('memory round trip: corpus nist-sp800-53r5, 492 pages (opt-in)', async () => {
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
  // For real documents the tab memory is only recorded (docs/m5-perf.md 3.3).
  expect(mem.wasmHeapDeltaMiB).not.toBeNull();
  expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
});

test('large page content regression (synthetic, first edit of 10 paragraphs on an inflated 8 MiB page): WASM in-use heap increase ≤ 64 MiB', async () => {
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
    // Whether the scenario took the intended path: all 10 paragraphs on the large page (page 0) were edited for the first time (not block re-edits).
    const committed = mem.editLog.filter((e) => e.committed);
    expect(committed).toHaveLength(10);
    expect(committed.every((e) => e.pageIndex === 0 && e.editedBlock === false)).toBe(true);
    // Estimated journal holding: the compressed size (about 1.7 MiB) times 10, not inflated content (8 MiB) × 10.
    expect(committed.at(-1)!.journalBytes!).toBeLessThan(32 * MiB);
    expect(mem.wasmHeapDeltaMiB).not.toBeNull();
    expect(mem.wasmHeapDeltaMiB!).toBeLessThanOrEqual(64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory round trip: corpus kogl-mods-cpi-202609 (opt-in, same scenario as Windows W2)', async () => {
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
