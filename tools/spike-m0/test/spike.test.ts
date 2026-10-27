import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (see src/spike.ts).
import { runIncrementalControls, runSpike, SEARCH_TERMS, type SpikeResult } from '../src/spike.js';
import { buildSamplePdf } from '../src/fixture.js';

const asset = (p: string) => fileURLToPath(new URL(`../../../assets/fonts/${p}`, import.meta.url));
const TTF = asset('NotoSansKR-Regular-subset.ttf');
const OTF = asset('src/NotoSansKR-Regular.otf');

function spike(fontPath: string): SpikeResult {
  return runSpike({
    sampleBytes: buildSamplePdf(),
    expectedBytes: buildSamplePdf({ includeTarget: false }),
    fontBytes: new Uint8Array(readFileSync(fontPath)),
    fontName: 'NotoSansKR',
  });
}

describe('M0 spike: paragraph replacement + Korean fallback font embedding (TTF)', () => {
  const r = spike(TTF);

  it('redaction erases only the target paragraph text and preserves background, rules, images, and adjacent text', () => {
    expect(r.redaction.targetTextBefore).toBe(true);
    expect(r.redaction.targetTextAfter).toBe(false);
    expect(r.redaction.diffVsExpectedPx).toBe(0);
    expect(r.redaction.diffOutsideRectPx).toBe(0);
    expect(r.redaction.preexistingRedactAnnots).toBe(0);
  });

  it('after redaction canBeSavedIncrementally=false → full save', () => {
    expect(r.canBeSavedIncrementally).toEqual({
      afterOpen: true,
      afterRedaction: false,
      afterContent: false,
    });
    expect(r.save.method).toBe('full');
  });

  it('the fallback font has every character and the text does not exceed the area', () => {
    expect(r.layout.missing).toEqual([]);
    expect(r.layout.overflow).toBe(false);
  });

  it('pre-save and reopened renders match the direct font-file render (reference) pixel for pixel', () => {
    expect(r.preSave.referenceInkPx).toBeGreaterThan(1000);
    expect(r.preSave.diffVsReferencePx).toBe(0);
    expect(r.reopen.diffVsReferencePx).toBe(0);
  });

  it('text extraction and search after reopening (ToUnicode)', () => {
    expect(r.reopen.textFound).toBe(true);
    expect(r.reopen.removedTextAbsent).toBe(true);
    expect(r.reopen.keptTextsPresent).toBe(true);
    for (const term of SEARCH_TERMS) expect(r.reopen.searchHits[term]).toBeGreaterThan(0);
  });

  it('the font is subset-embedded as Type0/CIDFontType2 + FontFile2 and has ToUnicode', () => {
    expect(r.reopen.font).toMatchObject({
      subtype: 'Type0',
      descendantSubtype: 'CIDFontType2',
      fontFileKey: 'FontFile2',
      subsetTagged: true,
      hasToUnicode: true,
    });
    expect(r.reopen.font!.fontFileBytes!).toBeLessThan(500_000);
  });
});

describe('incremental save control', () => {
  const c = runIncrementalControls(buildSamplePdf());

  it('changing only annotations gives an incremental save', () => {
    expect(c.annotationOnly.canBeSavedIncrementally).toBe(true);
    expect(c.annotationOnly.decided).toBe('incremental');
    expect(c.annotationOnly.ok).toBe(true);
  });

  it('after redaction MuPDF does not reject an incremental save, and the start of the output is the original unchanged', () => {
    // canBeSavedIncrementally() is advisory. The save method must be enforced by decideSaveMethod.
    expect(c.afterRedaction.canBeSavedIncrementally).toBe(false);
    expect(c.afterRedaction.ok).toBe(true);
    expect(c.afterRedaction.prefixIsOriginal).toBe(true);
  });
});

describe.skipIf(!existsSync(OTF))(
  'control: CFF OTF fallback font (known MuPDF 1.28.1 failure)',
  () => {
    it('the reopened render differs greatly from the reference and is not subset', () => {
      // The original OTF is not in git (assets/fonts/src). Even with skipIf the describe body runs at collection time, so
      // file reading is done inside the test.
      const r = spike(OTF);
      // If this test fails, MuPDF behavior has changed → reassess the CFF path.
      expect(r.reopen.diffVsReferencePx).toBeGreaterThan(1000);
      expect(r.reopen.font?.subsetTagged).toBe(false);
      expect(r.reopen.font?.descendantSubtype).toBe('CIDFontType0');
    });
  },
);
