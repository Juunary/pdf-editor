import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { buildSourceMap, linkPage } from '../src/index.js';
import { measureDocument } from '../src/measure.js';
import { buildTestPageModel } from './helpers/page-model.js';

/**
 * fixtures/m0 문서 매칭률(docs/m1-pdf-ops.md 5.2절). 기준은 MuPDF Device 콜백(테스트 전용 PageModel).
 */
const dir = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.pdf'))
  .sort();
const open = (file: string) =>
  mupdf.Document.openDocument(readFileSync(dir + file), 'application/pdf') as mupdf.PDFDocument;

describe('fixtures/m0 매칭률', () => {
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

  it('측정 도구(measureDocument): 두 정책 모두 실패 쪽 0', () => {
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
