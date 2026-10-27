import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (see src/redact-spike.ts).
import { runRedactCase, LINK_URI } from '../src/redact-spike.js';

const TTF = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);
const fontBytes = new Uint8Array(readFileSync(TTF));

describe('editing a document with existing Redact annotations', () => {
  it('pre-edit report: 3 in the document (2 on page 1, 1 on page 2), R2 overlaps the edit area, 1 link to be removed → warn', () => {
    const r = runRedactCase('per-annotation', fontBytes);
    expect(r.reportBefore).toEqual({ total: 3, pages: [0, 1] });
    expect(r.impact).toMatchObject({
      preexisting: 2,
      overlapping: ['R2'],
      linksRemoved: [LINK_URI],
      level: 'warn',
    });
  });

  it('edit path (per annotation): applies only the new redaction; existing annotations and the text under them stay as is after saving', () => {
    const r = runRedactCase('per-annotation', fontBytes);
    expect(r.afterEdit).toMatchObject({
      redactAnnots: [2, 1],
      existingObjectsUnchanged: true,
      changedObjects: ['page1'],
      adjacentTextPresent: true,
      targetTextPresent: false,
      newTextFound: true,
      notePresent: true,
      links: 0,
    });
    expect(r.render).toEqual({ page1OutsideTargetPx: 0, page2VsOriginalPx: 0 });
    expect(r.save.method).toBe('full');
    expect(r.reopen).toMatchObject({
      redactAnnots: [2, 1],
      reportSame: true,
      existingTreesSame: [true, true, true],
      adjacentTextPresent: true,
      newTextFound: true,
      page1OutsideTargetPx: 0,
      page2VsOriginalPx: 0,
    });
    expect(r.mupdfMessages).toEqual([]);
  });

  it('control: page-level applyRedactions applies the existing annotations (R1·R2) and erases even the adjacent paragraph', () => {
    const r = runRedactCase('page-level', fontBytes);
    expect(r.afterEdit.redactAnnots).toEqual([0, 1]);
    expect(r.afterEdit.adjacentTextPresent).toBe(false);
    expect(r.render.page1OutsideTargetPx).toBeGreaterThan(1000);
  });

  it('policy "temporary detach": existing annotations and the text under them remain even with page-level redaction', () => {
    const r = runRedactCase('detach', fontBytes);
    expect(r.afterEdit).toMatchObject({
      redactAnnots: [2, 1],
      existingObjectsUnchanged: true,
      adjacentTextPresent: true,
      targetTextPresent: false,
    });
    expect(r.render).toEqual({ page1OutsideTargetPx: 0, page2VsOriginalPx: 0 });
    expect(r.reopen.reportSame).toBe(true);
  });
});
