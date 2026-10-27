// Re-classifies the measurement JSON with the coefficients in the code (`packages/pdf-ops` SAVE_HEAP_COEFFICIENTS) (docs/m5-heap.md section 4 table).
// Usage: node tools/bench/heap-check.mjs out/m5-heap/measure-v3.jsonl [...]
// This classification uses the final coefficients (full fit + margin). LOO is produced by heap-fit.mjs.
import { readFileSync } from 'node:fs';
import {
  estimateSaveHeapModel,
  estimateSaveHeapRatio,
  STREAM_INPUT_PEAK_HEAP_RATIO,
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
  .filter((r) => r.stats);
/** Measured peak of the first save. If the first save failed, the limit (in the two-save scenario a failure of the second save arrives as r.ok=false). */
const firstPeak = (r) => (typeof r.peak === 'number' ? r.peak : LIMIT);
const docMax = new Map();
for (const r of rows) {
  const key = `${r.id}:${r.variant}`;
  docMax.set(key, Math.max(docMax.get(key) ?? 0, firstPeak(r)));
}
const tally = {};
const lines = [];
for (const r of rows) {
  const method = r.plan?.method ?? (r.variant.startsWith('none') ? 'incremental' : 'full');
  const peak = firstPeak(r);
  const model = estimateSaveHeapModel(method, {
    inputBytes: r.inputBytes,
    model: {
      objectCount: r.stats.objectCount,
      rawStreamBytes: r.stats.rawStreamBytes,
      objectStreamBytes: r.stats.objectStreamBytes ?? 0,
      approximate: r.stats.approximate,
      currentHeapBytes: r.marks.plan,
      baseHeapBytes: r.marks.open,
      journalBytes: r.plan?.heap?.journalBytes ?? 0,
    },
  });
  const old = estimateSaveHeapRatio(method, {
    inputBytes: r.inputBytes,
    ratio: STREAM_INPUT_PEAK_HEAP_RATIO,
  });
  for (const [name, e] of [
    ['model', model],
    ['old', old],
  ]) {
    const key = `${name}:${method}${HOLDOUT.has(r.id) ? ':holdout' : ''}`;
    const t = (tally[key] ??= { n: 0, miss: 0, flagged: 0, over: 0, overDoc: 0 });
    t.n++;
    if (peak > e.estimatedPeakBytes) t.miss++;
    if (e.level !== 'ok') {
      t.flagged++;
      if (peak < LIMIT * 0.5) t.over++;
      if (docMax.get(`${r.id}:${r.variant}`) < LIMIT * 0.5) t.overDoc++;
    }
  }
  lines.push(
    [
      r.id,
      method,
      r.viewPages ?? 0,
      (peak / MIB).toFixed(1),
      r.ok ? '' : '실패',
      (model.estimatedPeakBytes / MIB).toFixed(1),
      model.level,
      (old.estimatedPeakBytes / MIB).toFixed(1),
      old.level,
    ].join('\t'),
  );
}
if (process.env.HEAP_CHECK_ROWS) console.log(lines.join('\n'));
console.table(tally);
