/**
 * M5 벤치마크 서버 정식 실행(계약 4.1·D1). 옵트인: BENCH_RUN=1 일 때만 돈다.
 *
 *   BENCH_RUN=1 BENCH_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus \
 *     pnpm --filter @pdf-editor/extension exec playwright test e2e/bench-run.spec.ts
 *
 * 환경 변수
 *   BENCH_TIER       fixtures/bench/manifest.json 의 tier(쉼표 목록, 기본 core)
 *   BENCH_DOCS       문서 id 쉼표 목록(기본: tier 전체)
 *   BENCH_SCENARIOS  시나리오 쉼표 목록(기본: 전체)
 *   BENCH_LABEL      결과 파일 이름(기본: 시각)
 *   BENCH_BASELINE   직전 기록 JSON 경로(기본 fixtures/bench/baseline-server.json). +20% 초과 지표를 회귀로 표시한다.
 *
 * 결과: out/m5-bench/<label>.json (측정 페이지 결과 + 렌더러 VmRSS 추적 + 회귀 표). 탭 메모리는 이 확장 렌더러의 VmRSS 다.
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
import { DEFAULT_OPTIONS, type Scenario } from '../src/viewer/bench-run.js';

const RUN = process.env.BENCH_RUN === '1';
const OUT_DIR = join(REPO, 'out/m5-bench');

test.describe('M5 벤치마크 정식 실행(옵트인)', () => {
  test.skip(!RUN, 'BENCH_RUN=1 이 아니면 건너뛴다');
  test.setTimeout(6 * 60 * 60 * 1000);

  test('문서 세트 전체 지표', async () => {
    const tier = process.env.BENCH_TIER ?? 'core';
    const args = ['fixtures/bench/prepare.mjs', '--tier', tier];
    if (process.env.BENCH_CORPUS_DIR) args.push('--corpus-dir', process.env.BENCH_CORPUS_DIR);
    let docs = JSON.parse(
      execFileSync('node', args, { cwd: REPO, maxBuffer: 1 << 24 }).toString(),
    ) as BenchDocFile[];
    const only = process.env.BENCH_DOCS?.split(',');
    if (only) docs = docs.filter((d) => only.includes(d.id));
    expect(docs.length).toBeGreaterThan(0);
    const scenarios = (process.env.BENCH_SCENARIOS?.split(',') ??
      DEFAULT_OPTIONS.scenarios) as Scenario[];

    // 문서마다 새 브라우저(새 렌더러 프로세스)로 잰다: 앞 문서가 남긴 JS·WASM 메모리가 탭 메모리 기준을 흐리지 않게.
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
              ([list, sc]) => window.__bench.run(list, { scenarios: sc as never }),
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
