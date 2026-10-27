import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { buildSourceMap, linkPage } from '../src/index.js';
import { measureDocument } from '../src/measure.js';
import { buildTestPageModel } from './helpers/page-model.js';

/**
 * fixtures/m0 document matching rate (docs/m1-pdf-ops.md section 5.2). The reference is the MuPDF Device callbacks (test-only PageModel).
 */
const dir = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.pdf'))
  .sort();
const open = (file: string) =>
  mupdf.Document.openDocument(readFileSync(dir + file), 'application/pdf') as mupdf.PDFDocument;

describe('fixtures/m0 matching rate', () => {
  for (const file of files) {
    it(file, () => {
      const doc = open(file);
      for (let p = 0; p < doc.countPages(); p++) {
        const model = buildTestPageModel(doc, p);
        const map = buildSourceMap(doc, p);
        const { stats } = linkPage(model, map);
        expect({
          page: p,
          errors: map.errors.length,
          glyphDelta: stats.glyphCountDelta,
          paintDelta: stats.paintCountDelta,
          unmatchedChars: stats.chars - stats.matchedChars,
          unmatchedPaints: stats.paints - stats.matchedPaints,
        }).toEqual({
          page: p,
          errors: 0,
          glyphDelta: 0,
          paintDelta: 0,
          unmatchedChars: 0,
          unmatchedPaints: 0,
        });
        expect(stats.maxOriginError).toBeLessThan(0.01);
      }
    });
  }

  it('measurement tool (measureDocument): zero failed pages for both policies', () => {
    const docs = files.map((f) => measureDocument(f, open(f), buildTestPageModel));
    for (const d of docs) {
      expect(d.pageErrors).toEqual([]);
      for (const policy of ['first-arrival', 'no-clip'] as const) {
        expect(d.byPolicy[policy]!.failedPages).toEqual([]);
        expect(d.byPolicy[policy]!.pages).toBe(d.pageCount);
      }
    }
  });
});
