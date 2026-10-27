import { describe, expect, it } from 'vitest';
// core must be imported before mupdf so that the WASM heap probe object is attached (src/wasm-module.ts).
import { PdfSession } from '../src/index.js';
import * as mupdf from 'mupdf';
import { buildPdf } from './pdf-fixtures.js';

/** 200x100pt, blue rectangle on the left half. */
function bluePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, '0 0 1 rg 0 0 100 100 re f'));
  return doc.saveToBuffer('').asUint8Array().slice();
}

describe('PdfSession', () => {
  it('open → render page 1 as RGBA (opaque white background)', () => {
    const s = new PdfSession();
    const info = s.open(bluePdf());
    expect(info.pageCount).toBe(1);
    expect(info.firstPage).toEqual({ width: 200, height: 100 });

    const page = s.renderPage({ pageIndex: 0, scale: 2 });
    expect([page.width, page.height]).toEqual([400, 200]);
    expect(page.rgba.length).toBe(400 * 200 * 4);
    const px = (x: number, y: number) =>
      Array.from(page.rgba.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4));
    expect(px(50, 100)).toEqual([0, 0, 255, 255]);
    expect(px(350, 100)).toEqual([255, 255, 255, 255]);
    s.close();
  });

  it('a save without changes is incremental, and one including redaction is a full save', () => {
    const s = new PdfSession();
    s.open(bluePdf());
    const inc = s.save({ changes: [] });
    expect(inc.method).toBe('incremental');
    expect(inc.canBeSavedIncrementally).toBe(true);
    expect(new TextDecoder().decode(inc.bytes.subarray(0, 5))).toBe('%PDF-');

    const full = s.save({ changes: ['redaction'] });
    expect(full.method).toBe('full');
    expect(full.wasmHeapBytes).toBeGreaterThan(0);
    expect(full.heap?.inputBytes).toBe(s.originalBytes.byteLength);
  });

  it('input mode and page info of the open result', () => {
    const s = new PdfSession();
    expect(s.open(bluePdf()).inputMode).toBe('stream');
    expect(s.getPageInfo(0)).toEqual({
      pageIndex: 0,
      bounds: [0, 0, 200, 100],
      size: { width: 200, height: 100 },
      rotation: 0,
    });
    s.close();
  });

  it('the pre-save check does not save and returns the mode and expected peak heap', () => {
    const s = new PdfSession();
    s.open(bluePdf());
    const plan = s.planSave({ changes: ['content-stream'] });
    expect(plan.method).toBe('full');
    expect(plan.heap.level).toBe('ok');
    // pdf-ops rounds the expected peak to integer bytes.
    expect(
      Math.abs(plan.heap.estimatedPeakBytes - plan.heap.inputBytes * plan.heap.ratio),
    ).toBeLessThanOrEqual(1);
    expect(s.planSave({ changes: [] }).method).toBe('incremental');
    s.close();
  });

  it('the extraction and search RPC implementations are connected to the session', () => {
    const s = new PdfSession();
    s.open(
      buildPdf(['BT /F1 12 Tf 10 150 Td (find me) Tj ET', 'BT /F1 12 Tf 10 150 Td (other) Tj ET']),
    );
    expect(
      s
        .extractPage({ pageIndex: 0 })
        .chars.map((c) => c.text)
        .join(''),
    ).toBe('find me');
    expect(s.searchText({ query: 'other' }).hits.map((h) => h.pageIndex)).toEqual([1]);
    s.close();
  });

  it('caches the page SourceMap so that the unmatched marks of linkPage remain in the getSourceMap result', () => {
    const s = new PdfSession();
    // Because of a known core limitation (Tr 7 of another BT after Tr 0 at the same position), the SourceMap counts 2 more glyphs → unpaired operations.
    const show = (tr: number, body: string) => `BT /F1 12 Tf ${tr} Tr 10 150 Td ${body} ET`;
    s.open(
      buildPdf([
        `${show(0, '(AB) Tj')} 0 0 5 5 re f ${show(7, '(AB) Tj')}`,
        'BT /F1 12 Tf 10 150 Td (other) Tj ET',
      ]),
    );
    const before = s.getSourceMap(0);
    expect(s.getSourceMap(0)).toBe(before);
    const link = s.linkPage(0);
    expect(link.stats.glyphCountDelta).toBe(-2);
    const after = s.getSourceMap(0);
    expect(after).toBe(before);
    const unmatched = after.ops.filter((o) => o.limits.includes('unmatched'));
    expect(unmatched.map((o) => o.op)).toEqual(['Tj']);
    // Even if matched again, the mark appears only once.
    s.linkPage(0);
    expect(unmatched[0]!.limits.filter((r) => r === 'unmatched')).toHaveLength(1);

    // Page cache invalidation: only that page is rebuilt.
    const other = s.getSourceMap(1);
    s.invalidatePageCache(0);
    expect(s.getSourceMap(0)).not.toBe(before);
    expect(s.getSourceMap(1)).toBe(other);
    s.invalidatePageCache();
    expect(s.getSourceMap(1)).not.toBe(other);
    s.close();
  });
});

describe('PdfSession.getPageLayout', () => {
  const content = [
    'BT /F1 18 Tf 72 720 Td (Title Heading) Tj ET',
    'BT /F1 10 Tf 72 690 Td (first paragraph line one is long enough to fill the column) Tj',
    '0 -12 Td (and it continues on this line.) Tj ET',
    'BT /F1 10 Tf 72 640 Td (Second paragraph starts here and ends.) Tj ET',
  ].join('\n');

  it('heading and paragraph reconstruction, page cache, cache invalidation', () => {
    const s = new PdfSession();
    s.open(buildPdf([{ content, mediabox: [0, 0, 612, 792] }]));
    const layout = s.getPageLayout(0);
    expect(layout.pageIndex).toBe(0);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([[0], [1, 2], [3]]);
    expect(layout.paragraphs.map((p) => p.role)).toEqual(['heading', 'body', 'body']);
    expect(layout.paragraphs[1]!.text).toBe(
      'first paragraph line one is long enough to fill the column and it continues on this line.',
    );
    expect(layout.readingOrder.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(s.getPageLayout(0)).toBe(layout);
    s.invalidatePageCache(0);
    expect(s.getPageLayout(0)).not.toBe(layout);
    s.close();
  });

  it('the layout cache keeps up to 16 pages in most-recently-used order (older pages are recomputed)', () => {
    const s = new PdfSession();
    s.open(
      buildPdf(
        Array.from({ length: 18 }, () => ({
          content,
          mediabox: [0, 0, 612, 792] as [number, number, number, number],
        })),
      ),
    );
    const first = s.getPageLayout(0);
    for (let i = 1; i <= 16; i++) s.getPageLayout(i);
    expect(s.getPageLayout(16)).toBe(s.getPageLayout(16));
    expect(s.getPageLayout(0)).not.toBe(first);
    s.close();
  });
});

describe('PdfSession.extractPage · model without segments', () => {
  it('even if the request without segments comes first, one extraction builds both models, and it matches the model with segments', () => {
    const s = new PdfSession();
    s.open(bluePdf());
    const plain = s.extractPage({ pageIndex: 0 });
    const full = s.extractPage({ pageIndex: 0, includePathSegments: true });
    expect(plain.paths.length).toBeGreaterThan(0);
    expect(plain.paths.every((p) => p.segments === null)).toBe(true);
    expect(full.paths.some((p) => p.segments !== null)).toBe(true);
    expect(plain.chars).toBe(full.chars);
    expect(plain.paths.map((p) => ({ ...p, segments: null }))).toEqual(
      full.paths.map((p) => ({ ...p, segments: null })),
    );
    // The same request gives the same object.
    expect(s.extractPage({ pageIndex: 0 })).toBe(plain);
    expect(s.extractPage({ pageIndex: 0, includePathSegments: true })).toBe(full);
    // Clearing the page cache rebuilds both.
    s.invalidatePageCache(0);
    expect(s.extractPage({ pageIndex: 0 })).not.toBe(plain);
  });
});
