#!/usr/bin/env node
// Splits and measures the composition of the page editability classification (first entry) outside the Worker (direct PdfSession calls, no structured clone) (M5 contract 4.1).
//
//   pnpm --filter @pdf-editor/core build
//   node packages/core/bench/judge-breakdown.mjs --doc /mnt/nas4/kjune/pdf-editor/fixtures/corpus/kogl-mods-cpi-202609.pdf --pages 3,12,21 --reps 5
//
// One iteration = two new sessions. Session A: after common initialization such as font loading (page 0 classification), the total time of the first `getPageEditability` call on the target page (cold).
// Session B: after the same initialization, call the steps in order (earlier step results reuse the cache, so each value is the time that step newly added).
//   extract (no segments) -> extractSeg (with) -> sourceMap -> link -> layout -> judge (remaining classification). Values are the median and minimum over iterations.
// Result: out/m5-judge/<label>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PdfSession } from '@pdf-editor/core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values: args } = parseArgs({
  options: {
    doc: { type: 'string' },
    pages: { type: 'string' },
    reps: { type: 'string', default: '5' },
    label: { type: 'string' },
  },
});
if (!args.doc || !args.pages) {
  console.error('사용: --doc FILE.pdf --pages 3,12 [--reps 5] [--label NAME]');
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(args.doc));
const pages = args.pages.split(',').map(Number);
const reps = Number(args.reps);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = async (fn) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};
async function session() {
  const s = new PdfSession();
  s.open(bytes.slice());
  await s.getPageEditability(0); // clear the common initialization (font loading) out of the way.
  return s;
}

const rows = [];
for (const p of pages) {
  const cold = [];
  const steps = { extract: [], extractSeg: [], sourceMap: [], link: [], layout: [], judge: [] };
  for (let r = 0; r < reps; r++) {
    const a = await session();
    cold.push(await ms(() => a.getPageEditability(p)));
    const b = await session();
    steps.extract.push(await ms(() => b.extractPage({ pageIndex: p })));
    steps.extractSeg.push(
      await ms(() => b.extractPage({ pageIndex: p, includePathSegments: true })),
    );
    steps.sourceMap.push(await ms(() => b.getSourceMap(p)));
    steps.link.push(await ms(() => b.linkPage(p)));
    steps.layout.push(await ms(() => b.getPageLayout(p)));
    steps.judge.push(await ms(() => b.getPageEditability(p)));
  }
  const row = { page: p, reps, coldMedian: median(cold), coldMin: Math.min(...cold) };
  for (const [k, v] of Object.entries(steps)) row[`${k}Median`] = median(v);
  rows.push(row);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]),
      ),
    ),
  );
}
const outDir = join(repo, 'out/m5-judge');
mkdirSync(outDir, { recursive: true });
const label =
  args.label ?? `${basename(args.doc, '.pdf')}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
writeFileSync(
  join(outDir, `${label}.json`),
  JSON.stringify({ doc: basename(args.doc), node: process.version, rows }, null, 1),
);
