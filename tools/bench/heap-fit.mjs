// 저장 힙 모델 계수 적합·검증(docs/m5-heap.md 3·4절).
// 사용: node tools/bench/heap-fit.mjs out/m5-heap/measure.jsonl [더 많은 jsonl ...] [--json out/m5-heap/fit.json]
// - 저장 경로(full·incremental)마다 계수를 두 방법으로 정한다.
//   ls: 비음수 최소 제곱 후 적합 표본 전부를 덮도록 배율 k 를 올린다(계약 D5 문구 그대로).
//   lp: 적합 표본 전부를 덮는다는 제약(미탐 0) 아래 상대 과대 추정 합을 최소화한다(선형 계획, 계수 ≥ 0).
// - 문서 단위 leave-one-out: 검증 문서를 빼고 적합한 계수로 그 문서를 예측한다. HOLDOUT(대용량)은 적합에서 빼고 검증만 한다.
// - 미탐: 측정 피크 > 예상 피크(측정 실패는 피크 = 상한으로 본다). 과탐: warn·over-limit 판정 중 측정 피크 < 상한 × 0.5.
// - 비교: 이전 배율 모델(입력 × 3.48 전체 / 2.98 증분, `STREAM_INPUT_PEAK_HEAP_RATIO`).
import { readFileSync, writeFileSync } from 'node:fs';
import { HOLDOUT } from './synth.mjs';

const MIB = 2 ** 20;
const LIMIT = 2 ** 31;
const WARN = 0.75;
/** emscripten 힙 확장 규칙(docs/m0-dod-xobject-redact-save.md 3.1): 새 크기 = max(요청, 현재 × 1.2), 요청 + 96 MiB 이하. */
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
    const objectBytes =
      Math.max(0, r.inputBytes - r.stats.rawStreamBytes) + (r.stats.objectStreamBytes ?? 0);
    return {
      id: r.id,
      view: r.viewPages ?? 0,
      group: r.group,
      holdout: HOLDOUT.has(r.id) || r.group === 'real-large',
      method,
      ok: r.ok,
      inputBytes: r.inputBytes,
      objectCount: r.stats.objectCount,
      rawStreamBytes: r.stats.rawStreamBytes,
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

/** 모델 입력. objectBytes = (입력 − 원 스트림) + 객체 스트림을 푼 크기(객체 사전·배열의 대략 크기). */
const FEATURE_SETS = {
  contract: ['inputBytes', 'objectCount', 'rawStreamBytes'],
  objbytes: ['inputBytes', 'objectCount', 'rawStreamBytes', 'objectBytes'],
};

/** 작은 연립방정식(가우스 소거). 특이하면 null. */
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

/** 비음수 최소 제곱(변수 ≤ 4: 부분집합 전수). X 는 행 = 표본. 계수 배열(열 순서). */
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
 * 모델 형태.
 * - linear: 예상 피크 = H + inc (계약 D5 그대로). H = max(현재 힙, 기본 + 저널).
 * - step: 예상 피크 = max(현재, min(1.2 × (H + inc), H + inc + 96 MiB)). 힙 확장이 한 번에 현재의 1.2배까지 커지는 계단을 덮는다.
 * inc = k × (d + a·입력 + b·객체 + c·원 스트림). d 는 intercept 변형에서만.
 */
/**
 * 객체형 계수 하한(사전값, MiB 단위 계수: objectCount 는 Mi 개당 MiB = 개당 byte). 객체 크기 신호를 가진 측정 문서가
 * nasa-se-handbook 하나뿐이라 그 문서를 빼면(LOO) 계수가 0 으로 떨어진다. 하한은 측정 문서 전체에서 본 객체당·객체 바이트당
 * 증가분의 대략 값이다(docs/m5-heap.md 3.2).
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
 * 선형 계획 min c·x s.t. A x ≥ b, x ≥ 0 (c ≥ 0). 쌍대 max b·y s.t. Aᵀy ≤ c, y ≥ 0 을 단체법(Bland 규칙)으로 풀고
 * 원 문제 해를 여유 변수 열의 목적 행 값으로 읽는다. 변수 수 ≤ 5, 제약 수 ≤ 수백.
 */
function lp(A, b, c) {
  const m = c.length;
  const n = A.length;
  // 행 i(원 변수 i): Σ_k A[k][i] y_k + s_i = c_i
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

/** 표본이 요구하는 최소 증가분(MiB). 측정 피크를 덮으려면 필요량이 얼마여야 하는지 식을 거꾸로 푼다. */
function requiredIncrement(form, r) {
  if (r.peak <= r.current) return -Infinity;
  const need = form.step ? Math.max(r.peak / GROWTH, r.peak - GROWTH_CAP) : r.peak;
  return (need - r.held) / MIB;
}

/** 적합(lp): 미탐 0 제약 아래 상대 과대 추정 합 최소. `form.lower` 는 계수 하한(사전값, MiB 단위 계수). */
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
  // 수치 오차로 생기는 미세한 미탐을 막는다.
  return { coef: extra.map((v, j) => (v + lb[j]) * (1 + 1e-9)), k: 1 + 1e-6 };
}

/** 적합(ls): 비음수 최소 제곱 → 적합 표본을 모두 덮는 최소 배율 k(≥ 1). */
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

/** 문서·저장 경로별 시나리오 최대 측정 피크. 과탐(문서 기준)은 판정이 난 시나리오에서 이 값이 상한 × 0.5 미만인 경우. */
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
  // 이전 배율 모델
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
 * 안전 여유(선택한 형태 `CHOSEN`): 증가분 = KS × (lp 증가분) + AS. KS 는 계수 오차, AS 는 작은 문서의 힙 확장 계단을
 * 덮는다. LOO 미탐 0 을 만족하는 조합 중 과탐(문서 기준 → 시나리오 기준)이 가장 적고 여유가 작은 것을 고른다.
 * 여유를 LOO 로 고르므로 LOO 결과는 여유 선택에 쓰인 값이다(docs/m5-heap.md 4절에 밝힌다).
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
      // 평균 과대 추정(예상 ÷ 측정, 실패 표본 제외): 같은 과탐이면 여유가 작은 쪽을 고르는 기준.
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
