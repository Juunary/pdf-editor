// M3 core 계측(docs/m3-core.md 4절). 먼저 `pnpm --filter @pdf-editor/core build` 로 dist 를 만든다.
//
//   node scripts/measure-m3.mjs region <PDF 폴더> [문서 수=12] [반복=7]   V8: 변경 영역 렌더 시간(쪽 전체 렌더 대비)
//   node --expose-gc scripts/measure-m3.mjs journal-heap <ops> <쪽 콘텐츠 KB> [off|on]
//                                                                       저널 보유 메모리(쪽 콘텐츠 스트림을 작업마다 교체)
//   node --expose-gc scripts/measure-m3.mjs journal-stream <ops> <스트림 KB> [off|on]
//                                                                       작업마다 스트림 하나(KB 크기)를 교체할 때의 힙 증가
//   node --expose-gc scripts/measure-m3.mjs journal-oneop <쓰기 수> <스트림 KB>
//                                                                       한 작업 안에서 같은 스트림을 반복해 쓸 때의 힙 증가
//
// 코퍼스 PDF 는 커밋하지 않는다(fixtures/corpus/manifest.json). 읽기 전용으로만 연다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfSession, wasmHeapBytes } from '../dist/index.js';
import * as mupdf from 'mupdf';

const [command, ...args] = process.argv.slice(2);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = (n, d = 1) => +n.toFixed(d);

/** 문단 하나·세 줄·반 쪽 크기의 영역(페이지 공간 pt). 쪽 가운데 위쪽 기준. */
const CLIPS = [
  { name: '문단 한 줄(300×14pt)', w: 300, h: 14 },
  { name: '문단 6줄(400×80pt)', w: 400, h: 80 },
  { name: '반 쪽(300×400pt)', w: 300, h: 400 },
];
const SCALES = [1.5, 2];

function region(dir, docLimit = 12, repeat = 7) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.pdf'))
    .sort()
    .slice(0, docLimit);
  const rows = [];
  for (const name of files) {
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    const session = new PdfSession();
    let open;
    try {
      open = session.open(bytes);
    } catch (error) {
      rows.push({ file: name, error: String(error.message ?? error) });
      continue;
    }
    const pages = [...new Set([0, Math.min(3, open.pageCount - 1)])];
    for (const pageIndex of pages) {
      const info = session.getPageInfo(pageIndex);
      const page = session.document.loadPage(pageIndex);
      const contentBytes = (() => {
        try {
          const c = page.getObject().get('Contents');
          const streams = c.isArray() ? [...Array(c.length).keys()].map((i) => c.get(i)) : [c];
          return streams.reduce((n, s) => n + s.readStream().asUint8Array().length, 0);
        } catch {
          return null;
        }
      })();
      page.destroy();
      for (const scale of SCALES) {
        const time = (fn) => {
          fn(); // 첫 호출(글꼴·캐시 데우기)은 제외
          const ms = [];
          for (let i = 0; i < repeat; i++) {
            const t0 = performance.now();
            fn();
            ms.push(performance.now() - t0);
          }
          return ms;
        };
        const full = time(() => session.renderPage({ pageIndex, scale }));
        rows.push({
          file: name,
          page: pageIndex + 1,
          pageBytes: contentBytes,
          scale,
          clip: '쪽 전체',
          p50: round(percentile(full, 50)),
          p95: round(percentile(full, 95)),
        });
        for (const c of CLIPS) {
          const x0 = Math.max(0, (info.size.width - c.w) / 2);
          const y0 = Math.min(info.size.height * 0.3, Math.max(0, info.size.height - c.h));
          const clip = [
            x0,
            y0,
            Math.min(info.size.width, x0 + c.w),
            Math.min(info.size.height, y0 + c.h),
          ];
          const ms = time(() => session.renderPage({ pageIndex, scale, clip }));
          rows.push({
            file: name,
            page: pageIndex + 1,
            pageBytes: contentBytes,
            scale,
            clip: c.name,
            p50: round(percentile(ms, 50)),
            p95: round(percentile(ms, 95)),
          });
        }
      }
    }
    session.close();
  }
  // 요약: 영역 종류·배율별 쪽 단위 p50 의 분포.
  const summary = {};
  for (const r of rows.filter((r) => r.p50 !== undefined)) {
    const key = `${r.clip} @${r.scale}`;
    (summary[key] ??= []).push(r);
  }
  const table = Object.entries(summary).map(([key, list]) => ({
    구성: key,
    쪽수: list.length,
    'p50 중앙값(ms)': round(
      percentile(
        list.map((r) => r.p50),
        50,
      ),
    ),
    'p50 p95(ms)': round(
      percentile(
        list.map((r) => r.p50),
        95,
      ),
    ),
    'p95 최대(ms)': round(Math.max(...list.map((r) => r.p95))),
  }));
  console.log(JSON.stringify({ rows }, null, 0).length > 0 ? '' : '');
  console.table(table);
  console.log(
    '쪽 목록(전체 렌더 p50 상위 5, 영역 렌더 대비):',
    JSON.stringify(
      rows
        .filter((r) => r.clip === '쪽 전체' && r.scale === 2)
        .sort((a, b) => b.p50 - a.p50)
        .slice(0, 5)
        .map((r) => ({
          file: r.file,
          page: r.page,
          pageKB: r.pageBytes === null ? null : Math.round(r.pageBytes / 1024),
          fullMs: r.p50,
          paragraphMs: rows.find(
            (x) =>
              x.file === r.file &&
              x.page === r.page &&
              x.scale === 2 &&
              x.clip.startsWith('문단 6줄'),
          )?.p50,
        })),
    ),
  );
  console.log('오류:', JSON.stringify(rows.filter((r) => r.error)));
  console.log('WASM 힙(MiB):', round((wasmHeapBytes() ?? 0) / 2 ** 20));
}

/** 저널이 작업마다 보유하는 메모리: 쪽 콘텐츠 스트림을 작업마다 교체하고 WASM 힙 증가를 잰다. */
async function journalHeap(opsArg, pageKbArg, mode = 'on') {
  const ops = Number(opsArg);
  const pageKb = Number(pageKbArg);
  const d = new mupdf.PDFDocument();
  const f1 = d.addSimpleFont(new mupdf.Font('Helvetica'));
  const filler = Array.from(
    { length: pageKb * 10 },
    (_, i) => `BT /F1 8 Tf 10 ${i % 190} Td (line ${i} of body text here) Tj ET`,
  ).join('\n');
  d.insertPage(-1, d.addPage([0, 0, 300, 200], 0, { Font: { F1: f1 } }, filler));
  const b = d.saveToBuffer('');
  const bytes = b.asUint8Array().slice();
  b.destroy();
  d.destroy();
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  if (mode === 'on') doc.enableJournal();
  const pageObj = doc.loadPage(0).getObject();
  const contents = pageObj.get('Contents');
  const orig = contents.readStream().asUint8Array().slice();
  const gc = async () => {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 0));
  };
  await gc();
  const h0 = wasmHeapBytes();
  let block;
  const t0 = performance.now();
  for (let i = 0; i < ops; i++) {
    if (mode === 'on') doc.beginOperation(`e${i}`);
    if (!block) {
      block = doc.addStream('x', {
        Type: doc.newName('XObject'),
        Subtype: doc.newName('Form'),
        BBox: [0, 0, 300, 200],
      });
      pageObj.get('Resources').put('XObject', doc.newDictionary());
      pageObj.get('Resources').get('XObject').put('EB', block);
    }
    const next = new Uint8Array(orig.length + 16);
    next.set(orig);
    next.set(new TextEncoder().encode(` % ${i}`.padEnd(16)), orig.length);
    contents.writeStream(next);
    for (let k = 0; k < 20; k++)
      block.writeStream(`BT /F1 10 Tf 10 100 Td (${'y'.repeat(3000 + k)}) Tj ET`);
    if (mode === 'on') doc.endOperation();
    if (i % 10 === 9) await gc();
  }
  const ms = performance.now() - t0;
  await gc();
  const growth = wasmHeapBytes() - h0;
  let undoMs = null;
  if (mode === 'on') {
    const u0 = performance.now();
    for (let i = 0; i < ops; i++) doc.undo();
    undoMs = performance.now() - u0;
  }
  console.log(
    JSON.stringify({
      mode,
      ops,
      pageContentKB: round(orig.length / 1024),
      heapGrowthMiB: round(growth / 2 ** 20, 2),
      perOpKiB: round(growth / ops / 1024, 1),
      editLoopMs: round(ms),
      undoAllMs: undoMs === null ? null : round(undoMs, 2),
      steps: mode === 'on' ? doc.getJournal().steps.length : null,
    }),
  );
}

/** 작업마다(또는 한 작업 안에서) 스트림 하나를 교체할 때의 WASM 힙 증가. */
async function journalStream(opsArg, kbArg, mode = 'on', oneOp = false) {
  const ops = Number(opsArg);
  const bytes = Number(kbArg) * 1024;
  const d = new mupdf.PDFDocument();
  const f1 = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(
    -1,
    d.addPage([0, 0, 300, 200], 0, { Font: { F1: f1 } }, 'BT /F1 12 Tf 10 150 Td (x) Tj ET'),
  );
  const b = d.saveToBuffer('');
  const raw = b.asUint8Array().slice();
  b.destroy();
  d.destroy();
  const doc = mupdf.PDFDocument.openDocument(raw, 'application/pdf');
  if (mode === 'on') doc.enableJournal();
  const stream = (() => {
    if (mode === 'on') doc.beginOperation('init');
    const s0 = doc.addStream('x', {});
    if (mode === 'on') doc.endOperation();
    return s0;
  })();
  const gc = async () => {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 0));
  };
  await gc();
  const h0 = wasmHeapBytes();
  if (oneOp) doc.beginOperation('one');
  for (let i = 0; i < ops; i++) {
    if (!oneOp && mode === 'on') doc.beginOperation(`e${i}`);
    stream.writeStream(`BT ${String.fromCharCode(97 + (i % 26)).repeat(bytes)} ET`);
    if (!oneOp && mode === 'on') doc.endOperation();
    if (i % 10 === 9) await gc();
  }
  if (oneOp) doc.endOperation();
  await gc();
  const growth = wasmHeapBytes() - h0;
  console.log(
    JSON.stringify({
      mode: oneOp ? 'one-operation' : mode,
      writes: ops,
      streamKB: Number(kbArg),
      heapGrowthMiB: round(growth / 2 ** 20, 2),
      perWriteKiB: round(growth / ops / 1024, 1),
    }),
  );
}

if (command === 'region')
  region(args[0], args[1] ? Number(args[1]) : undefined, args[2] ? Number(args[2]) : undefined);
else if (command === 'journal-stream')
  await journalStream(args[0] ?? '500', args[1] ?? '195', args[2]);
else if (command === 'journal-oneop')
  await journalStream(args[0] ?? '200', args[1] ?? '195', 'on', true);
else if (command === 'journal-heap') await journalHeap(args[0] ?? '100', args[1] ?? '100', args[2]);
else {
  console.error(
    '사용법: region <폴더> [문서 수] [반복] | journal-heap <ops> <쪽 콘텐츠 KB> [off|on]',
  );
  process.exit(2);
}
