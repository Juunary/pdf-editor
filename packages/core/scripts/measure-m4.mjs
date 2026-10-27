// M4 core measurement (docs/m4-core.md section 4, contract 5.1 V5 and 6.2). First build dist with `pnpm --filter @pdf-editor/core build`.
//
//   node scripts/measure-m4.mjs max-paths <PDF folder> [document name prefix ...]
//       Counts paths per page to find the corpus page with the most paths (to fix the V5 measurement page). With prefixes, only those documents.
//   node scripts/measure-m4.mjs drag <PDF> <page (0-based)> [paths=10] [steps=50] [scale=2]
//       Moves N large paths each step and measures `updatePathDraft` time (stream rewrite + changed-area render).
//       If the pdf-ops path write is implemented this is the real path; with "M4 미구현" (not implemented) it is a substitute measurement (rewrite the whole page content stream with the same
//       bytes + render the same area), distinguished in the output by `mode`.
//
// Corpus PDFs are not committed (fixtures/corpus/manifest.json). They are opened read-only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfSession } from '../dist/index.js';

const [command, ...args] = process.argv.slice(2);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = (n, d = 1) => +n.toFixed(d);
const stats = (values) => ({
  n: values.length,
  p50: round(percentile(values, 50)),
  p95: round(percentile(values, 95)),
  max: round(Math.max(...values)),
});

function maxPaths(dir, prefixes) {
  const files = readdirSync(dir)
    .filter(
      (f) => f.endsWith('.pdf') && (prefixes.length === 0 || prefixes.some((p) => f.startsWith(p))),
    )
    .sort();
  const rows = [];
  for (const name of files) {
    const session = new PdfSession();
    let pageCount;
    try {
      pageCount = session.open(new Uint8Array(readFileSync(join(dir, name)))).pageCount;
    } catch (error) {
      rows.push({ file: name, error: String(error.message ?? error) });
      continue;
    }
    let best = { page: -1, paths: -1, ms: 0 };
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const t0 = performance.now();
      let paths;
      try {
        paths = session
          .extractPage({ pageIndex })
          .paths.filter((p) => p.op === 'fill' || p.op === 'stroke').length;
      } catch {
        continue;
      }
      if (paths > best.paths) best = { page: pageIndex, paths, ms: round(performance.now() - t0) };
      session.invalidatePageCache(pageIndex);
    }
    rows.push({ file: name, pageCount, maxPage: best.page, paths: best.paths, extractMs: best.ms });
    session.close();
  }
  rows.sort((a, b) => (b.paths ?? -1) - (a.paths ?? -1));
  console.table(rows);
}

async function drag(file, pageArg, countArg = '10', stepsArg = '50', scaleArg = '2') {
  const pageIndex = Number(pageArg);
  const count = Number(countArg);
  const steps = Number(stepsArg);
  const scale = Number(scaleArg);
  const session = new PdfSession();
  session.open(new Uint8Array(readFileSync(file)));
  const area = (p) => (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]);
  // Only paths that pass the editability classification (the real path after integration). Classification time is measured too.
  const te = performance.now();
  const editability = await session.getPageEditability(pageIndex);
  const editabilityMs = performance.now() - te;
  const chosen = editability.paths
    .filter((p) => p.editable)
    .sort((a, b) => area(b) - area(a))
    .slice(0, count);
  const paintSeqs = chosen.map((p) => p.paintSeq);
  const union = chosen
    .map((p) => p.bbox)
    .reduce((a, b) => [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ]);
  const info = session.getPageInfo(pageIndex);
  const dx = 0.5;
  const sample = {
    file,
    pageIndex,
    paths: paintSeqs.length,
    pagePaths: editability.paths.length,
    pageEditablePaths: editability.paths.filter((p) => p.editable).length,
    editabilityMs: round(editabilityMs),
    pageWidth: info.width ?? null,
    steps,
  };

  let mode = 'real';
  let times = [];
  let commitMs = null;
  let planMs = null;
  let beginMs = null;
  try {
    const tp = performance.now();
    const plan = await session.planPathEdit(pageIndex, paintSeqs);
    planMs = performance.now() - tp;
    if (!plan.editable) throw new Error(`편집 불가: ${plan.limits.map((l) => l.reason).join(',')}`);
    const tb = performance.now();
    const started = await session.beginPathEdit(pageIndex, paintSeqs, plan.revision);
    beginMs = performance.now() - tb;
    for (let k = 1; k <= steps; k++) {
      const t0 = performance.now();
      await session.updatePathDraft(
        started.draftId,
        {
          transform: [1, 0, 0, 1, dx * k, 0],
          fill: null,
          stroke: null,
          lineWidth: null,
          points: null,
          delete: false,
        },
        scale,
      );
      times.push(performance.now() - t0);
    }
    const t1 = performance.now();
    await session.commitPathEdit(started.draftId);
    commitMs = performance.now() - t1;
  } catch (error) {
    if (!String(error.message ?? error).startsWith('M4 미구현')) throw error;
    mode = 'proxy';
    times = proxyDrag(session, pageIndex, union, steps, dx, scale);
  }
  console.log(
    JSON.stringify(
      {
        ...sample,
        mode,
        scale,
        updateMs: stats(times),
        ...(mode === 'proxy'
          ? { writeMs: stats(proxyParts.write), renderMs: stats(proxyParts.render) }
          : {}),
        planMs: planMs === null ? null : round(planMs),
        beginMs: beginMs === null ? null : round(beginMs),
        commitMs: commitMs === null ? null : round(commitMs),
      },
      null,
      2,
    ),
  );
  session.close();
}

/**
 * Substitute measurement: inside a journal-on operation, rewrite the page content stream with the same bytes (an upper bound on the stream write cost of replacing the bytes of one path)
 * and render the before ∪ after box. Does not include the cost of the path write implementation itself (operator rewriting, fingerprint).
 */
const proxyParts = { write: [], render: [] };
function proxyDrag(session, pageIndex, union, steps, dx, scale) {
  const doc = session.document;
  doc.enableJournal();
  doc.beginOperation('proxy');
  const page = doc.loadPage(pageIndex);
  const contents = page.getObject().get('Contents');
  const streams = contents.isArray()
    ? [...Array(contents.length).keys()].map((i) => contents.get(i))
    : [contents];
  const bytes = streams.map((s) => {
    const buf = s.readStream();
    const copy = buf.asUint8Array().slice();
    buf.destroy();
    return copy;
  });
  const times = [];
  proxyParts.write = [];
  proxyParts.render = [];
  let previous = union;
  for (let k = 1; k <= steps; k++) {
    const t0 = performance.now();
    streams.forEach((s, i) => s.writeStream(bytes[i]));
    const tw = performance.now();
    const moved = [union[0] + dx * k, union[1], union[2] + dx * k, union[3]];
    const clip = [
      Math.min(previous[0], moved[0]) - 2,
      Math.min(previous[1], moved[1]) - 2,
      Math.max(previous[2], moved[2]) + 2,
      Math.max(previous[3], moved[3]) + 2,
    ];
    session.invalidateAround(pageIndex);
    session.renderPage({ pageIndex, scale, clip });
    const t1 = performance.now();
    proxyParts.write.push(tw - t0);
    proxyParts.render.push(t1 - tw);
    times.push(t1 - t0);
    previous = moved;
  }
  page.destroy();
  doc.abandonOperation();
  return times;
}

if (command === 'max-paths') maxPaths(args[0], args.slice(1));
else if (command === 'drag') await drag(...args);
else {
  console.error('사용법은 파일 머리말 참고');
  process.exit(1);
}
