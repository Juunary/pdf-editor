#!/usr/bin/env node
// 쪽 편집 가능 판정(첫 진입)의 구성을 Worker 밖(직접 PdfSession 호출, 구조화 복제 없음)에서 나눠 잰다(M5 계약 4.1).
//
//   pnpm --filter @pdf-editor/core build
//   node packages/core/bench/judge-breakdown.mjs --doc /mnt/nas4/kjune/pdf-editor/fixtures/corpus/kogl-mods-cpi-202609.pdf --pages 3,12,21 --reps 5
//
// 한 반복 = 새 세션 둘. 세션 A: 폰트 적재 등 공통 초기화(0쪽 판정) 뒤 대상 쪽의 `getPageEditability` 를 처음 부른 전체 시간(콜드).
// 세션 B: 같은 초기화 뒤 단계별로 순서대로 부른다(앞 단계 결과는 캐시를 재사용하므로 각 값은 그 단계가 새로 더한 시간).
//   extract(세그먼트 없음) → extractSeg(있음) → sourceMap → link → layout → judge(나머지 판정). 값은 반복의 중앙값·최소.
// 결과: out/m5-judge/<label>.json
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
  await s.getPageEditability(0); // 공통 초기화(폰트 적재)를 치운다.
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
