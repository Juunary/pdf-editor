import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (src/wasm-module.ts).
import { extractPageModel } from '../src/index.js';
import * as mupdf from 'mupdf';
import {
  formatMeasureTable,
  measureDocument,
  type DocumentMeasure,
  type ModelProvider,
} from '@pdf-editor/pdf-ops/measure';

/**
 * Corpus matching measurement using the real core extractPage (docs/m1-contract.md section 6, item 3). Skipped when the environment variable is not set.
 *
 *   CORE_LINK_MEASURE_DIR=<PDF folder>  [CORE_LINK_MEASURE_OUT=<result path, without extension>]
 *   pnpm --filter @pdf-editor/core exec vitest run test/corpus-link.test.ts
 *
 * core implements only the rule fixed in contract 3.1 (first-arrival), so only that policy is measured. The no-clip comparison uses the pdf-ops runner
 * (test/corpus-measure.test.ts, test helper PageModel).
 */
const dir = process.env.CORE_LINK_MEASURE_DIR;
const out = process.env.CORE_LINK_MEASURE_OUT;

const coreProvider: ModelProvider = (doc, pageIndex, policy) => {
  if (policy !== 'first-arrival') throw new Error(`core 는 first-arrival 만 구현: ${policy}`);
  const page = doc.loadPage(pageIndex);
  try {
    return extractPageModel(page, { pageIndex });
  } finally {
    page.destroy();
  }
};

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

describe.skipIf(!dir)(
  'corpus matching measurement: real core extractPage (CORE_LINK_MEASURE_DIR)',
  () => {
    it('failed pages and unmatched characters per document', () => {
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
        docs.push(measureDocument(file, doc, coreProvider, ['first-arrival']));
        doc.destroy();
      }
      const table = formatMeasureTable(docs);
      if (out) {
        writeFileSync(
          `${out}.json`,
          JSON.stringify({ measuredAt: new Date().toISOString(), docs, openErrors }, null, 2),
        );
        writeFileSync(`${out}.md`, table);
      } else {
        process.stdout.write(table);
      }
      expect(docs.length + openErrors.length).toBeGreaterThan(0);
    }, 3_600_000);
  },
);
