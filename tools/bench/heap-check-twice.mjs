// Classification of two saves in the same session (docs/m5-heap.md 4.4). Reads the heap-run.mjs --variants full2,none2 results and recomputes the estimate for the second save
// with the old formula (treats the current heap as in use) and the new formula (post-previous-save usage estimate, `usedHeapAfterSave`), counting misses and false alarms.
// Usage: node tools/bench/heap-check-twice.mjs out/m5-heap/twice.jsonl [...]   (HEAP_CHECK_ROWS=1 prints one line per sample)
import { readFileSync } from 'node:fs';
import {
  estimateSaveHeapModel,
  usedHeapAfterSave,
  WASM_HEAP_LIMIT_BYTES,
} from '../../packages/pdf-ops/dist/save-method.js';
import { HOLDOUT } from './synth.mjs';

const MIB = 2 ** 20;
const LIMIT = WASM_HEAP_LIMIT_BYTES;
const rows = process.argv
  .slice(2)
  .flatMap((f) =>
    readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l)),
  )
  .filter((r) => r.stats && r.marks?.save !== undefined);

const group = (r) =>
  HOLDOUT.has(r.id) ? 'holdout' : r.group === 'synthetic' ? 'synthetic' : (r.group ?? 'corpus');
/** Measured peak of the second save. If the second save failed, the limit. */
const peak2 = (r) => (r.ok ? r.peak2 : LIMIT);
const docMax = new Map();
for (const r of rows) {
  const key = `${r.id}:${r.variant}`;
  docMax.set(key, Math.max(docMax.get(key) ?? 0, peak2(r)));
}

function estimate(r, method, used) {
  return estimateSaveHeapModel(method, {
    inputBytes: r.inputBytes,
    model: {
      objectCount: r.stats.objectCount,
      rawStreamBytes: r.stats.rawStreamBytes,
      objectStreamBytes: r.stats.objectStreamBytes ?? 0,
      approximate: r.stats.approximate,
      currentHeapBytes: r.marks.plan2,
      ...(used === undefined ? {} : { usedHeapBytes: used }),
      baseHeapBytes: r.marks.open,
      journalBytes: r.plan2?.heap?.journalBytes ?? 0,
    },
  });
}

const tally = {};
const lines = [];
for (const r of rows) {
  if (r.marks.plan2 === undefined) continue;
  const method = r.plan2?.method ?? (r.variant === 'none2' ? 'incremental' : 'full');
  const peak = peak2(r);
  const used1 = r.plan?.heap?.usedHeapBytes ?? r.marks.plan;
  const used = usedHeapAfterSave({ usedHeapBytes: used1, heapAfterBytes: r.peak }, r.marks.plan2);
  const estimates = [
    ['이전(현재 힙)', estimate(r, method, undefined)],
    ['새(사용 추정)', estimate(r, method, used)],
  ];
  for (const [name, e] of estimates) {
    const key = `${name}:${method}:${group(r)}`;
    const t = (tally[key] ??= { n: 0, miss: 0, flagged: 0, overLimit: 0, over: 0, overDoc: 0 });
    t.n++;
    if (peak > e.estimatedPeakBytes) t.miss++;
    if (e.level !== 'ok') {
      t.flagged++;
      if (e.level === 'over-limit') t.overLimit++;
      if (peak < LIMIT * 0.5) t.over++;
      if (docMax.get(`${r.id}:${r.variant}`) < LIMIT * 0.5) t.overDoc++;
    }
  }
  const [, oldE] = estimates[0];
  const [, newE] = estimates[1];
  lines.push(
    [
      r.id,
      method,
      r.viewPages ?? 0,
      (r.peak / MIB).toFixed(0),
      (r.marks.plan2 / MIB).toFixed(0),
      (peak / MIB).toFixed(0) + (r.ok ? '' : ' 실패'),
      `${(oldE.estimatedPeakBytes / MIB).toFixed(0)} ${oldE.level}`,
      `${(newE.estimatedPeakBytes / MIB).toFixed(0)} ${newE.level}${newE.grownHeapBasis ? ' 커진힙' : ''}`,
      r.plan2 ? `${(r.plan2.heap.estimatedPeakBytes / MIB).toFixed(0)}` : '-',
    ].join('\t'),
  );
}
if (process.env.HEAP_CHECK_ROWS) {
  console.log('id\tmethod\tview\tpeak1\theap@plan2\tpeak2\told\tnew\tproduct');
  console.log(lines.join('\n'));
}
console.table(tally);
