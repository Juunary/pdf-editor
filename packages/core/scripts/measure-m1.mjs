// M1 core measurement (docs/m1-core.md section 4). First build dist with `pnpm --filter @pdf-editor/core build`.
//
//   node scripts/measure-m1.mjs fixtures                 per-page extraction time, approximation frequency and WASM heap for the fixtures/m0 documents
//   node scripts/measure-m1.mjs dir <folder> [max pages per doc]  measures the PDFs in a folder the same way (read-only)
//   node scripts/measure-m1.mjs reading <folder> [max pages per doc]  spaceAfter ratio, assembled reading text vs asText() (whitespace-collapsed comparison)
//   node scripts/measure-m1.mjs gen <out.pdf> [pages]    synthetic large PDF (uncompressed noise stream on every page)
//   node scripts/measure-m1.mjs open <file> <mode>       open in one process (buffer|stream), then WASM heap
//   node scripts/measure-m1.mjs compare <file>           compare buffer and stream in separate processes
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PdfSession,
  assembleReadingText,
  extractPageDetailed,
  foldWhitespace,
  wasmHeapBytes,
} from '../dist/index.js';
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

function reading(dir, maxPages = Infinity) {
  if (!dir.endsWith('/')) dir += '/';
  const rows = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
    const session = new PdfSession();
    const open = session.open(new Uint8Array(readFileSync(dir + name)));
    for (let p = 0; p < Math.min(open.pageCount, maxPages); p++) {
      const model = session.extractPage({ pageIndex: p });
      const page = session.document.loadPage(p);
      const st = page.toStructuredText('');
      const expected = foldWhitespace(st.asText());
      st.destroy();
      page.destroy();
      const actual = foldWhitespace(assembleReadingText(model));
      const noSpaces = foldWhitespace(
        assembleReadingText({
          ...model,
          lines: model.lines.map((l) => ({ ...l, spaceAfter: [] })),
        }),
      );
      let diffAt = -1;
      if (actual !== expected) {
        diffAt = 0;
        while (diffAt < actual.length && actual[diffAt] === expected[diffAt]) diffAt++;
      }
      // Difference of the character multiset with whitespace removed: characters only in asText (missing) and characters only in the assembled text (extra).
      const count = (text) => {
        const m = new Map();
        for (const ch of text.replace(/\s/g, '')) m.set(ch, (m.get(ch) ?? 0) + 1);
        return m;
      };
      const a = count(actual);
      const e = count(expected);
      let missing = 0;
      let extra = 0;
      const missingChars = new Map();
      for (const [ch, n] of e) {
        const d = n - (a.get(ch) ?? 0);
        if (d > 0) {
          missing += d;
          missingChars.set(ch, d);
        }
      }
      for (const [ch, n] of a) extra += Math.max(0, n - (e.get(ch) ?? 0));
      rows.push({
        file: name,
        page: p,
        missing,
        extra,
        missingTop: [...missingChars.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4),
        chars: model.chars.length,
        lines: model.lines.length,
        spaceAfter: model.lines.reduce((n, l) => n + l.spaceAfter.length, 0),
        equal: actual === expected,
        equalWithoutSpaceAfter: noSpaces === expected,
        diffAt,
        actualSample: diffAt >= 0 ? actual.slice(Math.max(0, diffAt - 30), diffAt + 40) : '',
        expectedSample: diffAt >= 0 ? expected.slice(Math.max(0, diffAt - 30), diffAt + 40) : '',
      });
      session.invalidatePageCache(p);
    }
    session.close();
  }
  console.log(JSON.stringify(rows));
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
else if (command === 'reading') reading(args[0], args[1] ? Number(args[1]) : Infinity);
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
