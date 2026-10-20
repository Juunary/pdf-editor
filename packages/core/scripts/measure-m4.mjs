// M4 core 계측(docs/m4-core.md 4절, 계약 5.1 V5·6.2). 먼저 `pnpm --filter @pdf-editor/core build` 로 dist 를 만든다.
//
//   node scripts/measure-m4.mjs max-paths <PDF 폴더> [문서 이름 접두 ...]
//       쪽별 패스 수를 세어 코퍼스 최대 패스 쪽을 찾는다(V5 측정 쪽 고정용). 접두를 주면 그 문서만.
//   node scripts/measure-m4.mjs drag <PDF> <쪽(0부터)> [패스 수=10] [단계=50] [배율=2]
//       큰 패스 N개를 단계마다 이동하며 `updatePathDraft` 시간(스트림 다시 쓰기 + 변경 영역 렌더)을 잰다.
//       pdf-ops 패스 쓰기가 구현돼 있으면 실제 경로, "M4 미구현" 이면 대체 측정(쪽 콘텐츠 스트림 전체를 같은
//       바이트로 다시 쓰기 + 같은 영역 렌더)이며 출력에 `mode` 로 구분한다.
//
// 코퍼스 PDF 는 커밋하지 않는다(fixtures/corpus/manifest.json). 읽기 전용으로만 연다.
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
  // 편집 가능 판정을 통과한 패스만(통합 뒤 실제 경로). 판정 시간도 잰다.
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
 * 대체 측정: 저널을 켠 작업 안에서 쪽 콘텐츠 스트림을 같은 바이트로 다시 쓰고(패스 하나의 바이트 교체와 같은 스트림 쓰기
 * 비용의 상한) 편집 전 ∪ 후 상자를 렌더한다. 패스 쓰기 구현 자체의 비용(연산 재작성, 지문)은 포함하지 않는다.
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
