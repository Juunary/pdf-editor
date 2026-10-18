import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { buildSourceMap, linkPage } from '../src/index.js';
import { buildTestPageModel } from './helpers/page-model.js';

/**
 * fixtures/m0 문서 매칭률(docs/m1-pdf-ops.md 5절). 기준은 MuPDF Device 콜백(테스트 전용 PageModel).
 */
const dir = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.pdf'))
  .sort();

describe('fixtures/m0 매칭률', () => {
  for (const file of files) {
    it(file, () => {
      const doc = mupdf.Document.openDocument(
        readFileSync(dir + file),
        'application/pdf',
      ) as mupdf.PDFDocument;
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
});
