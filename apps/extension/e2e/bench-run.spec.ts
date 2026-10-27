/**
 * M5 benchmark server official run (contract 4.1·D1). Opt-in: runs only when BENCH_RUN=1.
 *
 *   BENCH_RUN=1 BENCH_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus \
 *     pnpm --filter @pdf-editor/extension exec playwright test e2e/bench-run.spec.ts
 *
 * Environment variables
 *   BENCH_TIER       tier of fixtures/bench/manifest.json (comma list, default core)
 *   BENCH_DOCS       comma list of document ids (default: the whole tier)
 *   BENCH_IDS        comma list of corpus document ids outside the bench set (prepare.mjs --ids, to measure the same documents as the Windows run)
 *   BENCH_SCENARIOS  comma list of scenarios (default: all)
 *   BENCH_OPTIONS    measurement options JSON (part of BenchOptions, e.g. '{"mem":{"pages":50,"edits":0,"saves":2,"settleMs":30000}}')
 *   BENCH_LABEL      result file name (default: timestamp)
 *   BENCH_BASELINE   path to the previous record JSON (default fixtures/bench/baseline-server.json). Metrics over +20% are flagged as regressions.
 *
 * Result: out/m5-bench/<label>.json (measurement page result + renderer VmRSS trace + regression table). Tab memory is the VmRSS of this extension's renderer.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO,
  exposeTabMemory,
  extensionRssMiB,
  gitHead,
  launchBenchBrowser,
  openBenchPage,
  serveDocs,
  type BenchDocFile,
} from './bench-harness.js';
import { compareRuns } from '../src/viewer/bench-stats.js';
import type { BenchResult } from '../src/viewer/bench.js';
import { DEFAULT_OPTIONS, type BenchOptions, type Scenario } from '../src/viewer/bench-run.js';

const RUN = process.env.BENCH_RUN === '1';
const OUT_DIR = join(REPO, 'out/m5-bench');

test.describe('M5 benchmark official run (opt-in)', () => {
  test.skip(!RUN, 'BENCH_RUN=1 이 아니면 건너뛴다');
  test.setTimeout(6 * 60 * 60 * 1000);

  test('full document set metrics', async () => {
    const tier = process.env.BENCH_TIER ?? 'core';
    const args = ['fixtures/bench/prepare.mjs', '--tier', tier];
    if (process.env.BENCH_CORPUS_DIR) args.push('--corpus-dir', process.env.BENCH_CORPUS_DIR);
    if (process.env.BENCH_IDS) args.push('--ids', process.env.BENCH_IDS);
    let docs = JSON.parse(
      execFileSync('node', args, { cwd: REPO, maxBuffer: 1 << 24 }).toString(),
    ) as BenchDocFile[];
    const only = process.env.BENCH_DOCS?.split(',');
    if (only) docs = docs.filter((d) => only.includes(d.id));
    expect(docs.length).toBeGreaterThan(0);
    const scenarios = (process.env.BENCH_SCENARIOS?.split(',') ??
      DEFAULT_OPTIONS.scenarios) as Scenario[];
    const extra = JSON.parse(process.env.BENCH_OPTIONS ?? '{}') as Partial<BenchOptions>;

    // A new browser (new renderer process) per document: so JS·WASM memory left by the previous document does not blur the tab memory baseline.
    const { server, base } = await serveDocs(docs);
    const trace: { t: number; mib: number; doc: string }[] = [];
    const labels: { label: string; docId: string; mib: number | null; t: number }[] = [];
    const parts: BenchResult[] = [];
    try {
      for (const d of docs) {
        const b = await launchBenchBrowser();
        const poll = setInterval(() => {
          const mib = extensionRssMiB(b.userDataDir);
          if (mib !== null) trace.push({ t: Date.now(), mib, doc: d.id });
        }, 250);
        try {
          const page = await openBenchPage(b);
          await exposeTabMemory(b, page, (label, docId, mib) =>
            labels.push({ label, docId, mib, t: Date.now() }),
          );
          page.on('console', (m) => {
            if (m.type() === 'error') console.log('[page]', m.text());
          });
          parts.push(
            (await page.evaluate(
              ([list, sc, opts]) =>
                window.__bench.run(list, { ...(opts as object), scenarios: sc as never }),
              [
                [
                  {
                    id: d.id,
                    name: `${d.id}.pdf`,
                    url: `${base}/${d.id}.pdf`,
                    bytes: d.bytes,
                    judgePages: d.judgePages,
                  },
                ],
                scenarios,
                extra,
              ] as const,
            )) as unknown as BenchResult,
          );
        } finally {
          clearInterval(poll);
          await b.close();
        }
      }
    } finally {
      server.close();
    }
    {
      const result: BenchResult = {
        ...parts[0]!,
        finishedAt: parts.at(-1)!.finishedAt,
        docs: parts.flatMap((p) => p.docs),
        p95: Object.assign({}, ...parts.map((p) => p.p95)) as Record<string, number>,
      };
      const baselinePath =
        process.env.BENCH_BASELINE ?? join(REPO, 'fixtures/bench/baseline-server.json');
      const regressions = existsSync(baselinePath)
        ? compareRuns(
            (JSON.parse(readFileSync(baselinePath, 'utf8')) as BenchResult).p95,
            result.p95,
          )
        : [];
      const out = {
        ...result,
        server: {
          commit: gitHead(),
          tier,
          scenarios,
          baseline: existsSync(baselinePath) ? baselinePath : null,
        },
        rssPeakMiB: trace.reduce((m, x) => Math.max(m, x.mib), 0),
        rssLabels: labels,
        regressions,
      };
      mkdirSync(OUT_DIR, { recursive: true });
      const label = process.env.BENCH_LABEL ?? new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(OUT_DIR, `${label}.json`), JSON.stringify(out, null, 1));
      console.log(
        JSON.stringify(
          { file: `out/m5-bench/${label}.json`, p95: result.p95, regressions },
          null,
          1,
        ),
      );
      for (const d of result.docs) expect(d.errors, `${d.id} 오류`).toEqual([]);
    }
  });
});
