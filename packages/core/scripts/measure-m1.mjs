// M1 core 계측(docs/m1-core.md 4절). 먼저 `pnpm --filter @pdf-editor/core build` 로 dist 를 만든다.
//
//   node scripts/measure-m1.mjs fixtures                 fixtures/m0 문서의 쪽별 추출 시간·근사 빈도·WASM 힙
//   node scripts/measure-m1.mjs dir <폴더> [문서당 최대 쪽수]  폴더의 PDF 를 같은 방식으로 측정(읽기 전용)
//   node scripts/measure-m1.mjs gen <out.pdf> [pages]    합성 대형 PDF(쪽마다 비압축 잡음 스트림)
//   node scripts/measure-m1.mjs open <file> <mode>       한 프로세스에서 열기(buffer|stream) 후 WASM 힙
//   node scripts/measure-m1.mjs compare <file>           buffer 와 stream 을 별도 프로세스로 비교
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfSession, extractPageDetailed, wasmHeapBytes } from '../dist/index.js';
import * as mupdf from 'mupdf';

const MiB = 2 ** 20;
const mib = (n) => (n == null ? null : +(n / MiB).toFixed(1));
const [command, ...args] = process.argv.slice(2);

function fixtures(
  dir = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url)),
  maxPages = Infinity,
) {
  if (!dir.endsWith('/')) dir += '/';
  const rows = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
    const bytes = new Uint8Array(readFileSync(dir + name));
    const session = new PdfSession();
    const heap0 = wasmHeapBytes();
    const open = session.open(bytes);
    for (let p = 0; p < Math.min(open.pageCount, maxPages); p++) {
      const page = session.document.loadPage(p);
      const t0 = performance.now();
      let result;
      try {
        result = extractPageDetailed(page, { pageIndex: p });
      } catch (e) {
        rows.push({
          file: name,
          pageCount: open.pageCount,
          page: p,
          error: String(e.message ?? e),
        });
        page.destroy();
        continue;
      }
      const { model, stats } = result;
      const ms = performance.now() - t0;
      page.destroy();
      rows.push({
        file: name,
        pageCount: open.pageCount,
        page: p,
        bytes: bytes.byteLength,
        extractMs: +ms.toFixed(2),
        ...stats,
        paints: model.paintCount,
        warnings: model.warnings.length,
        warningTexts: model.warnings
          .filter((w) => w.startsWith('MuPDF') || w.includes('실패'))
          .slice(0, 2),
        heapMiB: mib(wasmHeapBytes()),
        heapBeforeMiB: mib(heap0),
      });
    }
    session.close();
  }
  console.log(JSON.stringify(rows, null, 1));
}

function gen(out, pages = 100) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const noise = new Uint8Array(768 * 1024);
  let x = 12345;
  for (let i = 0; i < pages; i++) {
    for (let j = 0; j < noise.length; j++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      noise[j] = x >>> 24;
    }
    const image = doc.addStream(noise, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1024,
      Height: 768,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 595, 842],
        0,
        { Font: { F1: font }, XObject: { Im1: image } },
        `q 200 0 0 150 50 600 cm /Im1 Do Q BT /F1 12 Tf 50 560 Td (page ${i}) Tj ET`,
      ),
    );
  }
  writeFileSync(out, doc.saveToBuffer('').asUint8Array());
  console.log(`${out} ${pages} pages`);
}

function openOnce(file, mode) {
  const bytes = new Uint8Array(readFileSync(file));
  const base = wasmHeapBytes();
  const session = new PdfSession();
  const result = session.open(bytes, mode);
  const afterOpen = wasmHeapBytes();
  const page = session.document.loadPage(0);
  const t0 = performance.now();
  extractPageDetailed(page, { pageIndex: 0 });
  const extractMs = performance.now() - t0;
  page.destroy();
  const afterExtract = wasmHeapBytes();
  const plan = session.planSave({ changes: ['content-stream'] });
  const saved = session.save({ changes: ['content-stream'] });
  console.log(
    JSON.stringify({
      mode,
      fileMiB: mib(bytes.byteLength),
      baseHeapMiB: mib(base),
      afterOpenMiB: mib(afterOpen),
      afterPage0ExtractMiB: mib(afterExtract),
      openMs: +result.openMs.toFixed(1),
      page0ExtractMs: +extractMs.toFixed(2),
      planRatio: plan.heap.ratio,
      planEstimatedPeakMiB: mib(plan.heap.estimatedPeakBytes),
      afterFullSaveMiB: mib(saved.wasmHeapBytes),
      fullSaveMs: +saved.saveMs.toFixed(0),
      outputBytes: saved.bytes.byteLength,
    }),
  );
  session.close();
}

function compare(file) {
  const script = fileURLToPath(import.meta.url);
  for (const mode of ['buffer', 'stream']) {
    process.stdout.write(execFileSync('node', [script, 'open', file, mode], { encoding: 'utf8' }));
  }
}

if (command === 'fixtures') fixtures();
else if (command === 'dir') fixtures(args[0], args[1] ? Number(args[1]) : Infinity);
else if (command === 'gen') gen(args[0], args[1] ? Number(args[1]) : undefined);
else if (command === 'open') openOnce(args[0], args[1]);
else if (command === 'compare') compare(args[0]);
else {
  console.error(
    '사용: fixtures | gen <out> [pages] | open <file> <buffer|stream> | compare <file>',
  );
  process.exit(1);
}
