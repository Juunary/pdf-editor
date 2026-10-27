import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (see src/corpus-edit.ts).
import { analyzeForEdit } from '../src/corpus-cli.js';
import { judgeRestrictions, runCorpusEdit, type ParagraphContext } from '../src/corpus-edit.js';
import {
  mergeLineBlocks,
  rectsIntersect,
  scanSegments,
  type StextBlock,
} from '../src/corpus-select.js';
import { pickSharedTextForms, runFormUsageEdit } from '../src/corpus-xobject.js';
import { openPdf } from '@pdf-editor/core';
import { TARGET_RECT } from '../src/fixture.js';
import { m0FixturePairs, runPdfjsCheck } from '../src/pdfjs-check.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/m0/${name}`, import.meta.url))),
  );
const fontBytes = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);

describe('automatic corpus paragraph selection (stext)', () => {
  it('m0-sample: automatically picks the Day 1 hard-coded target paragraph and does not overlap adjacent paragraphs', () => {
    const r = analyzeForEdit(fixture('m0-sample.pdf'));
    expect(r.paragraphs).toHaveLength(1);
    const p = r.paragraphs[0]!;
    expect(p.lines.map((l) => l.text).join(' ')).toContain(
      'This paragraph is the replacement target.',
    );
    expect(p.fontSize).toBe(11);
    expect(p.linePitch).toBeCloseTo(14, 1);
    // The automatic area lies within the Day 1 hard-coded area
    expect(p.rect[0]).toBeGreaterThanOrEqual(TARGET_RECT[0]);
    expect(p.rect[1]).toBeGreaterThanOrEqual(TARGET_RECT[1]);
    expect(p.rect[3]).toBeLessThanOrEqual(TARGET_RECT[3]);
    expect(r.selection.rejected['too-few-lines']).toBe(3);
    expect(r.analysis.forms.usages).toBe(0);
  });

  it('shared XObject fixture: a text paragraph inside a Form is reported with its Form context (L-condition input)', () => {
    const r = analyzeForEdit(fixture('m0-shared-xobject.pdf'));
    expect(r.analysis.forms.shared).toBe(2);
    expect(r.analysis.forms.sharedWithText).toBe(2);
    for (const p of r.paragraphs) {
      expect(p.formUsagesOnPage).toBeGreaterThan(0);
      expect(p.textFormsOverlapping.length).toBeGreaterThan(0);
    }
  });

  it('scan ranges: 15%·50%·85% points + the remainder, no duplicates', () => {
    const segs = scanSegments(100);
    expect(segs[0]![0]).toBe(14); // floor(99 × 0.15)
    expect(segs[1]![0]).toBe(49);
    expect(segs[2]![0]).toBe(84);
    const all = segs.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(scanSegments(1)).toEqual([[0]]);
  });
});

describe('single-line block merging (documents where stext splits a block per line)', () => {
  const line = (y: number, x = 50, size = 10, text = 'lorem ipsum dolor sit amet'): StextBlock => ({
    bbox: [x, y - 8, x + 200, y + 2],
    lines: [
      {
        bbox: [x, y - 8, x + 200, y + 2],
        wmode: 0,
        dir: [1, 0],
        chars: [...text].map((c, i) => ({
          c,
          x: x + i * 5,
          y,
          size,
          font: 'F',
          box: [x + i * 5, y - 8, x + i * 5 + 5, y + 2],
        })),
      },
    ],
  });
  it('groups lines that are left-aligned, same size, and evenly spaced, and breaks at a line of a different size', () => {
    const blocks = [line(100), line(112), line(124), line(136), line(160, 50, 14), line(200)];
    const merged = mergeLineBlocks(blocks);
    expect(merged.map((m) => m.members)).toEqual([[0, 1, 2, 3]]);
  });
  it('breaks every 8 lines', () => {
    const blocks = Array.from({ length: 12 }, (_v, i) => line(100 + i * 12));
    expect(mergeLineBlocks(blocks).map((m) => m.members.length)).toEqual([8, 4]);
  });
});

describe('corpus paragraph replacement (redaction → Korean fallback embedding → full save)', () => {
  it('m0-sample: 0 failures, 0 px outside the edit area, reopen search hits, full save and heap check ok', () => {
    const plan = analyzeForEdit(fixture('m0-sample.pdf'));
    const r = runCorpusEdit({
      bytes: fixture('m0-sample.pdf'),
      paragraphs: plan.paragraphs,
      fontBytes,
    });
    const p = r.paragraphs[0]!;
    expect(p.failures).toEqual([]);
    expect(p.redaction.outsidePx).toBe(0);
    expect(p.redaction.neighborLinesLost).toBe(0);
    expect(p.preSave!.vsReferencePx).toBe(0);
    expect(p.layout!.lineCount).toBeLessThanOrEqual(p.lineCount);
    expect(Object.values(p.reopen!.searchHits).every((n) => n >= 1)).toBe(true);
    expect(r.save.method).toBe('full');
    expect(r.save.canBeSavedIncrementally).toEqual({ afterOpen: true, beforeSave: false });
    expect(r.save.heap!.level).toBe('ok');
    expect(r.font).toMatchObject({
      subtype: 'Type0',
      fontFileKey: 'FontFile2',
      hasToUnicode: true,
    });
    expect(r.mupdfMessages.count).toBe(0);
  });

  it('restriction classification: Form L1·L2·L7, tag MCID, mapping-risk characters', () => {
    const base = analyzeForEdit(fixture('m0-sample.pdf')).paragraphs[0]!;
    const ctx: ParagraphContext = {
      ...base,
      formUsagesOnPage: 2,
      textFormsOverlapping: [
        {
          objectNumber: 9,
          usages: 3,
          depth: 1,
          L1NoResources: true,
          L2StructParents: true,
          L6ParseError: false,
          L7OptionalContent: true,
        },
      ],
      mcidOnPage: 4,
      tagged: true,
      fontMappingRisk: ['X(Type3/-)'],
      unmappedRatio: 0.1,
    };
    const codes = judgeRestrictions(ctx).map((r) => `${r.code}:${r.level}`);
    expect(codes).toEqual([
      'L1:limit',
      'L2:limit',
      'L7:warn',
      'form-instancing:warn',
      'tagged:limit',
      'font-mapping:warn',
      'unmapped-text:limit',
    ]);
  });

  it('rectsIntersect: only intersections with area', () => {
    expect(rectsIntersect([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false);
    expect(rectsIntersect([0, 0, 10, 10], [9, 9, 20, 20])).toBe(true);
  });
});

describe('clone·modify only one shared Form usage location (corpus path)', () => {
  it('synthetic shared XObject: 2 text Forms, only the selected location changes and other pages differ by 0 px', () => {
    const bytes = fixture('m0-shared-xobject.pdf');
    const doc = openPdf(bytes);
    const picks = pickSharedTextForms(doc);
    doc.destroy();
    expect(picks.map((p) => p.usages.length)).toEqual([4, 5]);
    for (const [i, p] of picks.entries()) {
      const r = runFormUsageEdit(bytes, fontBytes, p.objectNumber, i + 1);
      expect(r.failures, `Form ${p.objectNumber}`).toEqual([]);
      expect(r.charsInBox.after).toBe(0);
      expect(r.render.otherPages).toEqual([{ pageIndex: 1, diffPx: 0 }]);
    }
  });
});

describe('independent pdf.js (pdfjs-dist) check', () => {
  it('3 fixtures/m0 edit results: Korean paragraph extraction, search terms, 0 px outside the edit area', async () => {
    const results = await runPdfjsCheck(
      m0FixturePairs(root),
      fileURLToPath(new URL('../../../out/m0-corpus/pdfjs-test', import.meta.url)),
    );
    for (const r of results) {
      expect(r.error, r.id).toBeUndefined();
      expect(r.ok, r.id).toBe(true);
      for (const p of r.pages) expect(p.inkRatioVsMupdf!, r.id).toBeGreaterThan(0.8);
    }
  }, 60_000);
});
