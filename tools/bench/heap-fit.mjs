// Save-heap model coefficient fit and validation (docs/m5-heap.md sections 3·4).
// Usage: node tools/bench/heap-fit.mjs out/m5-heap/measure.jsonl [more jsonl ...] [--json out/m5-heap/fit.json]
// - Coefficients are set per save path (full·incremental) with two methods.
//   ls: non-negative least squares, then raise the scale k until all fit samples are covered (wording of contract D5).
//   lp: minimize the sum of relative over-estimates under the constraint of covering all fit samples (zero misses) (linear programming, coefficients ≥ 0).
// - Per-document leave-one-out: predict the held-out document with coefficients fit without it. HOLDOUT (large documents) is excluded from the fit and used only for validation.
// - Miss: measured peak > estimated peak (a failed measurement counts as peak = limit). False alarm: among warn·over-limit classifications, measured peak < limit × 0.5.
// - Comparison: the earlier scale model (input × 3.48 full / 2.98 incremental, `STREAM_INPUT_PEAK_HEAP_RATIO`).
import { readFileSync, writeFileSync } from 'node:fs';
import { HOLDOUT } from './synth.mjs';

const MIB = 2 ** 20;
const LIMIT = 2 ** 31;
const WARN = 0.75;
/** emscripten heap growth rule (docs/m0-dod-xobject-redact-save.md 3.1): new size = max(requested, current × 1.2), at most requested + 96 MiB. */
const GROWTH = 1.2;
const GROWTH_CAP = 96 * MIB;
const OLD_RATIO = { full: 3.48, incremental: 2.98 };

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const files = args.filter(
  (a, i) => !a.startsWith('--') && !['--json', '--rows'].includes(args[i - 1]),
);

const rows = files
  .flatMap((f) =>
    readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l)),
  )
  .filter((r) => r.stats)
  .map((r) => {
    const method = r.variant === 'none' ? 'incremental' : 'full';
    const current = r.marks.plan ?? r.marks.stats;
    const base = r.marks.open;
    const journal = r.plan?.heap?.journalBytes ?? 0;
    const held = Math.max(current, base + journal);
    const peak = r.ok ? r.peak : LIMIT;
    // For a sample estimate, treat the original stream as the input (upper bound) (same rule as `saveHeapIncrement`).
    const raw = r.stats.approximate
      ? Math.max(r.stats.rawStreamBytes, r.inputBytes)
      : r.stats.rawStreamBytes;
    const objectBytes = Math.max(0, r.inputBytes - raw) + (r.stats.objectStreamBytes ?? 0);
    return {
      id: r.id,
      view: r.viewPages ?? 0,
      group: r.group,
      holdout: HOLDOUT.has(r.id) || r.group === 'real-large',
      method,
      ok: r.ok,
      inputBytes: r.inputBytes,
      objectCount: r.stats.objectCount,
      rawStreamBytes: raw,
      objectBytes,
      approximate: r.stats.approximate,
      current,
      base,
      journal,
      held,
      peak,
      y: peak - held,
    };
  });

/** Model inputs. objectBytes = (input − original stream) + decoded size of object streams (rough size of object dictionaries·arrays). */
const FEATURE_SETS = {
  contract: ['inputBytes', 'objectCount', 'rawStreamBytes'],
  objbytes: ['inputBytes', 'objectCount', 'rawStreamBytes', 'objectBytes'],
};

/** Small system of linear equations (Gaussian elimination). null if singular. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Non-negative least squares (variables ≤ 4: exhaustive over subsets). X rows = samples. Coefficient array (column order). */
function nnls(X, y) {
  const p = X[0].length;
  let best = null;
  for (let mask = 1; mask < 1 << p; mask++) {
    const cols = [...Array(p).keys()].filter((j) => mask & (1 << j));
    const A = cols.map((i) => cols.map((j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
    const b = cols.map((i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
    const sol = solve(A, b);
    if (!sol || sol.some((v) => v < 0)) continue;
    const coef = Array(p).fill(0);
    cols.forEach((j, k) => (coef[j] = sol[k]));
    const sse = X.reduce(
      (s, r, k) => s + (r.reduce((t, v, j) => t + v * coef[j], 0) - y[k]) ** 2,
      0,
    );
    if (!best || sse < best.sse) best = { coef, sse };
  }
  return best ? best.coef : Array(p).fill(0);
}

/**
 * Model shapes.
 * - linear: estimated peak = H + inc (as in contract D5). H = max(current heap, base + journal).
 * - step: estimated peak = max(current, min(1.2 × (H + inc), H + inc + 96 MiB)). Covers the step where one heap growth reaches 1.2× the current size.
 * inc = k × (d + a·input + b·objects + c·original stream). d only in the intercept variant.
 */
/**
 * Lower bounds for object-type coefficients (prior values, coefficients in MiB units: objectCount is MiB per Mi objects = bytes per object). Only one measured document carries an object-size signal
 * (nasa-se-handbook), so leaving it out (LOO) drops the coefficients to 0. The bounds are rough per-object and per-object-byte
 * increments seen across all measured documents (docs/m5-heap.md 3.2).
 */
const PRIOR = { objectCount: 400, objectBytes: 1.5 };
const FORMS = {};
for (const method of ['ls', 'lp']) {
  for (const [fs, list] of Object.entries(FEATURE_SETS)) {
    for (const step of [false, true]) {
      for (const intercept of [false, true]) {
        FORMS[`${method}/${fs}/${step ? 'step' : 'linear'}${intercept ? '+d' : ''}`] = {
          method,
          features: list,
          step,
          intercept,
        };
        if (method === 'lp' && fs === 'objbytes' && step && intercept) {
          FORMS['lp/objbytes/step+d/prior'] = {
            method,
            features: list,
            step,
            intercept,
            lower: PRIOR,
          };
        }
      }
    }
  }
}

function features(r, form) {
  const f = form.features.map((k) => r[k] / MIB);
  return form.intercept ? [1, ...f] : f;
}

function predictWith(form, coef, k, r) {
  const f = features(r, form);
  const inc = k * f.reduce((s, v, j) => s + v * coef[j], 0) * MIB;
  const need = r.held + inc;
  return form.step ? Math.max(r.current, Math.min(GROWTH * need, need + GROWTH_CAP)) : need;
}

/**
 * Linear program min c·x s.t. A x ≥ b, x ≥ 0 (c ≥ 0). Solves the dual max b·y s.t. Aᵀy ≤ c, y ≥ 0 with the simplex method (Bland's rule) and
 * reads the primal solution from the objective-row values of the slack-variable columns. Variables ≤ 5, constraints ≤ a few hundred.
 */
function lp(A, b, c) {
  const m = c.length;
  const n = A.length;
  // row i (primal variable i): Σ_k A[k][i] y_k + s_i = c_i
  const T = Array.from({ length: m }, (_, i) => {
    const row = new Array(n + m + 1).fill(0);
    for (let k = 0; k < n; k++) row[k] = A[k][i];
    row[n + i] = 1;
    row[n + m] = c[i];
    return row;
  });
  const z = new Array(n + m + 1).fill(0);
  for (let k = 0; k < n; k++) z[k] = -b[k];
  for (let iter = 0; iter < 10000; iter++) {
    let col = -1;
    for (let j = 0; j < n + m; j++) {
      if (z[j] < -1e-12) {
        col = j;
        break;
      }
    }
    if (col < 0) break;
    let row = -1;
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      if (T[i][col] > 1e-12) {
        const ratio = T[i][n + m] / T[i][col];
        if (ratio < best - 1e-12) {
          best = ratio;
          row = i;
        }
      }
    }
    if (row < 0) throw new Error('LP 쌍대 무한(원 문제 불능)');
    const pv = T[row][col];
    for (let j = 0; j <= n + m; j++) T[row][j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === row) continue;
      const f = T[i][col];
      if (f !== 0) for (let j = 0; j <= n + m; j++) T[i][j] -= f * T[row][j];
    }
    const f = z[col];
    for (let j = 0; j <= n + m; j++) z[j] -= f * T[row][j];
  }
  return Array.from({ length: m }, (_, i) => Math.max(0, z[n + i]));
}

/** Minimum increment (MiB) a sample requires. Inverts the formula to find how much is needed to cover the measured peak. */
function requiredIncrement(form, r) {
  if (r.peak <= r.current) return -Infinity;
  const need = form.step ? Math.max(r.peak / GROWTH, r.peak - GROWTH_CAP) : r.peak;
  return (need - r.held) / MIB;
}

/** Fit (lp): minimize the sum of relative over-estimates under zero misses. `form.lower` is the coefficient lower bound (prior values, coefficients in MiB units). */
function fitLp(form, train) {
  const names = form.intercept ? ['intercept', ...form.features] : form.features;
  const lb = names.map((n) => form.lower?.[n] ?? 0);
  const rowsReq = train
    .map((r) => {
      const f = features(r, form);
      return { f, req: requiredIncrement(form, r) - f.reduce((s, v, j) => s + v * lb[j], 0) };
    })
    .filter((x) => x.req > 0);
  const p = names.length;
  const c = Array.from(
    { length: p },
    (_, j) =>
      train.reduce((s, r) => s + features(r, form)[j] / Math.max(r.peak, 64 * MIB), 0) + 1e-9,
  );
  const extra = rowsReq.length
    ? lp(
        rowsReq.map((x) => x.f),
        rowsReq.map((x) => x.req),
        c,
      )
    : Array(p).fill(0);
  // Prevents tiny misses caused by numerical error.
  return { coef: extra.map((v, j) => (v + lb[j]) * (1 + 1e-9)), k: 1 + 1e-6 };
}

/** Fit (ls): non-negative least squares → the smallest scale k (≥ 1) that covers all fit samples. */
function fitLs(form, train) {
  const X = train.map((r) => features(r, form));
  const y = train.map((r) => Math.max(0, r.y) / MIB);
  const coef = nnls(X, y);
  const covered = (k) => train.every((r) => predictWith(form, coef, k, r) >= r.peak);
  let k = 1;
  if (!covered(k)) {
    let hi = 2;
    while (!covered(hi) && hi < 1e6) hi *= 2;
    let lo = hi / 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (covered(mid)) hi = mid;
      else lo = mid;
    }
    k = hi;
  }
  return { coef, k };
}

const fit = (form, train) => (form.method === 'lp' ? fitLp(form, train) : fitLs(form, train));

const level = (peak) => (peak > LIMIT ? 'over-limit' : peak > LIMIT * WARN ? 'warn' : 'ok');

function judge(pred, r) {
  const lv = level(pred);
  return {
    pred,
    level: lv,
    miss: r.peak > pred,
    flagged: lv !== 'ok',
    over: lv !== 'ok' && r.peak < LIMIT * 0.5,
  };
}

/** Maximum measured peak per document and save path across scenarios. A false alarm (per document) is a case where this value is below limit × 0.5 for a scenario that was flagged. */
const docMax = new Map();
for (const r of rows) {
  const key = `${r.id}:${r.method}`;
  docMax.set(key, Math.max(docMax.get(key) ?? 0, r.peak));
}

function summarize(judged, method) {
  const flagged = judged.filter((j) => j.flagged);
  const overDoc = flagged.filter((j) => docMax.get(`${j.id}:${method}`) < LIMIT * 0.5);
  return {
    n: judged.length,
    docs: new Set(judged.map((j) => j.id)).size,
    missDocs: new Set(judged.filter((j) => j.miss).map((j) => j.id)).size,
    misses: judged.filter((j) => j.miss).length,
    flagged: flagged.length,
    over: flagged.filter((j) => j.over).length,
    overRate: flagged.length ? flagged.filter((j) => j.over).length / flagged.length : 0,
    overDoc: overDoc.length,
    overDocRate: flagged.length ? overDoc.length / flagged.length : 0,
  };
}

const result = { forms: {}, old: {}, rows: [] };
for (const method of ['full', 'incremental']) {
  const all = rows.filter((r) => r.method === method);
  const fitSet = all.filter((r) => !r.holdout);
  // previous scale model
  const oldJ = all.map((r) => ({
    id: r.id,
    view: r.view,
    holdout: r.holdout,
    ...judge(r.inputBytes * OLD_RATIO[method], r),
  }));
  result.old[method] = { ...summarize(oldJ, method), rows: oldJ };
  for (const [name, form] of Object.entries(FORMS)) {
    const final = fit(form, fitSet);
    const loo = all.map((r) => {
      const train = fitSet.filter((t) => t.id !== r.id);
      const m = r.holdout ? final : fit(form, train);
      return {
        id: r.id,
        view: r.view,
        holdout: r.holdout,
        k: m.k,
        ...judge(predictWith(form, m.coef, m.k, r), r),
      };
    });
    result.forms[`${method}:${name}`] = {
      method,
      form: name,
      coef: final.coef,
      k: final.k,
      features: form.intercept ? ['intercept', ...form.features] : form.features,
      loo: summarize(loo, method),
      holdout: summarize(
        loo.filter((j) => j.holdout),
        method,
      ),
      rows: loo,
    };
  }
  result.rows.push(...all);
}

const fmt = (v) => (v / MIB).toFixed(1);
for (const [key, f] of Object.entries(result.forms)) {
  const c = f.coef.map((v) => (v * f.k).toPrecision(4)).join(', ');
  console.log(
    `${key.padEnd(32)} k=${f.k.toFixed(3)} coef×k=[${c}] LOO 미탐 ${f.loo.misses}/${f.loo.n}(문서 ${f.loo.missDocs}/${f.loo.docs}) 판정 ${f.loo.flagged} 과탐 ${f.loo.over}(${(f.loo.overRate * 100).toFixed(0)}%)·문서기준 ${f.loo.overDoc}(${(f.loo.overDocRate * 100).toFixed(0)}%) | 대용량 미탐 ${f.holdout.misses}/${f.holdout.n}`,
  );
}
for (const [m, o] of Object.entries(result.old)) {
  console.log(
    `old:${m} 미탐 ${o.misses}/${o.n}(문서 ${o.missDocs}/${o.docs}) 판정 ${o.flagged} 과탐 ${o.over}·문서기준 ${o.overDoc}`,
  );
}
/**
 * Safety margin (chosen form `CHOSEN`): increment = KS × (lp increment) + AS. KS covers coefficient error, AS covers the heap-growth step of small documents.
 * Pick, among combinations with zero LOO misses, the one with the fewest false alarms (per document → per scenario) and the smallest margin.
 * Because the margin is chosen by LOO, the LOO result is the value used to select the margin (stated in docs/m5-heap.md section 4).
 */
const CHOSEN = 'lp/objbytes/step+d/prior';
const KS = [1, 1.02, 1.05, 1.1, 1.2, 1.3, 1.5];
const AS = [0, 4, 8, 16, 32, 48];
function withMargin(form, m, ks, as) {
  const names = form.intercept ? ['intercept', ...form.features] : form.features;
  return {
    coef: m.coef.map((v, j) => (names[j] === 'intercept' ? v * ks + as : v * ks)),
    k: m.k,
  };
}
result.margin = {};
for (const method of ['full', 'incremental']) {
  const form = FORMS[CHOSEN];
  const all = rows.filter((r) => r.method === method);
  const fitSet = all.filter((r) => !r.holdout);
  const final = fit(form, fitSet);
  const looModels = new Map(
    all.map((r) => [
      r.id,
      r.holdout
        ? final
        : fit(
            form,
            fitSet.filter((t) => t.id !== r.id),
          ),
    ]),
  );
  const grid = [];
  for (const ks of KS) {
    for (const as of AS) {
      const judged = all.map((r) => {
        const m = withMargin(form, looModels.get(r.id), ks, as);
        return {
          id: r.id,
          view: r.view,
          holdout: r.holdout,
          ...judge(predictWith(form, m.coef, m.k, r), r),
        };
      });
      // Mean over-estimate (estimate ÷ measured, failed samples excluded): the criterion for preferring the smaller margin when false alarms are equal.
      const okRows = judged.filter((j, i) => all[i].ok);
      const excess =
        okRows.reduce((t, j, i) => t + j.pred / all.filter((r) => r.ok)[i].peak, 0) / okRows.length;
      grid.push({ ks, as, excess, ...summarize(judged, method), rows: judged });
    }
  }
  const ok = grid.filter((g) => g.misses === 0);
  ok.sort((a, b) => a.overDoc - b.overDoc || a.over - b.over || a.excess - b.excess);
  const best = ok[0] ?? null;
  const fm = best ? withMargin(form, final, best.ks, best.as) : null;
  const names = form.intercept ? ['intercept', ...form.features] : form.features;
  result.margin[method] = {
    form: CHOSEN,
    best: best && { ...best, rows: undefined },
    rows: best?.rows,
    lpCoefficients: Object.fromEntries(names.map((n, j) => [n, final.coef[j]])),
    coefficients: fm && Object.fromEntries(names.map((n, j) => [n, fm.coef[j] * fm.k])),
    grid: grid.map((g) => ({
      ks: g.ks,
      as: g.as,
      excess: g.excess,
      misses: g.misses,
      missDocs: g.missDocs,
      flagged: g.flagged,
      over: g.over,
      overDoc: g.overDoc,
    })),
  };
  console.log(
    `margin ${method}: ${best ? `KS=${best.ks} AS=${best.as} MiB 평균 예상/측정 ${best.excess.toFixed(2)} LOO 미탐 ${best.misses}/${best.n} 판정 ${best.flagged} 과탐 ${best.over}(${(best.overRate * 100).toFixed(0)}%)·문서기준 ${best.overDoc}(${(best.overDocRate * 100).toFixed(0)}%)` : '조건 만족 없음'}`,
  );
  if (fm) console.log(`  계수(MiB 단위): ${JSON.stringify(result.margin[method].coefficients)}`);
}

if (args.includes('--rows')) {
  const key = args[args.indexOf('--rows') + 1];
  const f = result.forms[key];
  for (const j of f.rows) {
    const r = rows.find((x) => x.id === j.id && x.method === f.method && x.view === j.view);
    const old = result.old[f.method].rows.find((x) => x.id === j.id && x.view === j.view);
    console.log(
      [
        j.id.padEnd(30),
        String(j.view).padStart(2),
        fmt(r.held),
        fmt(r.peak),
        fmt(j.pred),
        j.level,
        j.miss ? 'MISS' : '',
        j.over ? 'OVER' : '',
        '| old',
        fmt(old.pred),
        old.level,
        old.miss ? 'MISS' : '',
        old.over ? 'OVER' : '',
      ].join(' '),
    );
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
