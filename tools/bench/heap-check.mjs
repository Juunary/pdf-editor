// 코드에 넣은 계수(`packages/pdf-ops` SAVE_HEAP_COEFFICIENTS)로 측정 JSON 을 다시 판정한다(docs/m5-heap.md 4절 표).
// 사용: node tools/bench/heap-check.mjs out/m5-heap/measure-v3.jsonl [...]
// 이 판정은 최종 계수(전체 적합 + 여유) 기준이다. LOO 는 heap-fit.mjs 가 낸다.
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
/** 첫 저장 실측 피크. 첫 저장에서 실패했으면 상한(저장 2회 시나리오는 두 번째 저장 실패가 r.ok=false 로 온다). */
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
