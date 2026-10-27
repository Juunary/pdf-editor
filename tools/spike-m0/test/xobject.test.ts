import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (see src/xobject-spike.ts).
import { runXObjectCase, type XObjectCaseResult } from '../src/xobject-spike.js';

const TTF = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);
const fontBytes = new Uint8Array(readFileSync(TTF));
const unchangedLabels = ['A', 'A/Fx2', 'C', 'C/Fx2', 'D', 'D/Fx2', 'E(Fx2 직접)'];

function expectOthersUntouched(r: XObjectCaseResult) {
  expect(r.objects.changed).toEqual(['page1']);
  for (const u of r.usagesAfter) {
    expect(u.original, u.label).toBe(unchangedLabels.includes(u.label));
  }
  expect(r.render.page1OutsideSelectedPx).toBe(0);
  expect(r.render.page2VsOriginalPx).toBe(0);
  expect(r.reopen.page2VsOriginalPx).toBe(0);
  expect(r.reopen.page2TextSame).toBe(true);
  expect(r.reopen.page2TreeDecodedSame).toBe(true);
  expect(r.reopen.page2TreeRawSame).toBe(true);
  expect(r.save.method).toBe('full');
}

describe('shared Form XObject: clone and modify only the selected usage location', () => {
  it('fixture sharing structure: Fx1 in 4 places (2 on page 1 + 2 on page 2), Fx2 in 5 places (4 inside Fx1 + 1 direct on page 2)', () => {
    const r = runXObjectCase('depth1', { fontBytes });
    expect(r.usageCountsBefore).toEqual({ Fx1: 4, Fx2: 5 });
  });

  for (const c of ['depth1', 'depth2', 'sequential'] as const) {
    it(`${c}: only the target text is replaced; other locations and pages keep objects and render unchanged`, () => {
      const r = runXObjectCase(c, { fontBytes });
      expectOthersUntouched(r);
      expect(r.page1Content.afterBytes - r.page1Content.beforeBytes).toBe(1); // /Fx1 → /FxE0|/FxE1
      expect(r.render.afterRemovalVsExpectedPx).toBe(0);
      expect(r.render.referenceInkPx!).toBeGreaterThan(1000);
      expect(r.render.preSaveVsReferencePx).toBe(0);
      expect(r.reopen.page1VsReferencePx).toBe(0);
      expect(r.reopen.newTextFound.every(Boolean)).toBe(true);
      for (const e of r.edits) {
        expect(e.layout).toEqual({
          lineCount: e.layout.lineCount,
          overflow: false,
          missing: [],
          outsideFormBBox: false,
        });
        expect(e.newForms).toBe(2);
      }
      expect(r.mupdfMessages).toEqual([]);
    });
  }

  it('control: page redaction turns even the unselected location (A) on the same page into a new instance (render is the same)', () => {
    const r = runXObjectCase('mupdf-page-redaction', { fontBytes });
    expect(r.edits[0]!.newForms).toBe(4);
    const a = r.usagesAfter.find((u) => u.label === 'A')!;
    expect(a.original).toBe(false);
    expect(r.usagesAfter.filter((u) => u.original).map((u) => u.label)).toEqual([
      'C',
      'C/Fx2',
      'D',
      'D/Fx2',
      'E(Fx2 직접)',
    ]);
    expect(r.render.afterRemovalVsExpectedPx).toBe(0);
    expect(r.render.page1OutsideSelectedPx).toBe(0);
    expect(r.reopen.page2TreeRawSame).toBe(true);
  });
});
