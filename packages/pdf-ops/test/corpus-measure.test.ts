import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import {
  formatMeasureTable,
  measureDocument,
  type DocumentMeasure,
  type GlyphSeqPolicy,
} from '../src/measure.js';
import { buildTestPageModel } from './helpers/page-model.js';

/**
 * Corpus matching measurement runner (docs/m1-pdf-ops.md section 5.5). Skipped when the environment variable is absent.
 *
 *   LINK_MEASURE_DIR=<PDF folder>  [LINK_MEASURE_OUT=<result path, without extension>]  [LINK_MEASURE_POLICIES=first-arrival,no-clip]
 *   pnpm --filter @pdf-editor/pdf-ops exec vitest run test/corpus-measure.test.ts
 *
 * Result: <OUT>.json (per-document and per-policy summary, failed page numbers, page exceptions) and <OUT>.md (table). Without OUT, the table goes to stdout.
 * PageModel is built by the test helper (MuPDF Device, contract 3.1 classification). To measure with core extractPage,
 * pass a ModelProvider wrapping core to measureDocument in `@pdf-editor/pdf-ops/measure`.
 */
const dir = process.env.LINK_MEASURE_DIR;
const out = process.env.LINK_MEASURE_OUT;
const policies = (process.env.LINK_MEASURE_POLICIES ?? 'first-arrival,no-clip').split(
  ',',
) as GlyphSeqPolicy[];

function pdfFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith('.pdf')) found.push(p);
    }
  };
  walk(root);
  return found;
}

describe.skipIf(!dir)('corpus matching measurement (LINK_MEASURE_DIR)', () => {
  it('failed pages and glyph counts per document and per policy', () => {
    const docs: DocumentMeasure[] = [];
    const openErrors: { file: string; message: string }[] = [];
    for (const path of pdfFiles(dir!)) {
      const file = relative(dir!, path);
      let doc: mupdf.PDFDocument;
      try {
        doc = mupdf.Document.openDocument(
          readFileSync(path),
          'application/pdf',
        ) as mupdf.PDFDocument;
      } catch (e) {
        openErrors.push({ file, message: e instanceof Error ? e.message : String(e) });
        continue;
      }
      // doc.destroy() is not called: later cleanup of the remaining PDFObject wrappers may touch the freed document.
      docs.push(measureDocument(file, doc, buildTestPageModel, policies));
    }
    const table = formatMeasureTable(docs);
    if (out) {
      writeFileSync(
        `${out}.json`,
        JSON.stringify(
          { measuredAt: new Date().toISOString(), policies, docs, openErrors },
          null,
          2,
        ),
      );
      writeFileSync(`${out}.md`, table);
    } else {
      process.stdout.write(table);
    }
    expect(docs.length + openErrors.length).toBeGreaterThan(0);
  }, 3_600_000);
});
