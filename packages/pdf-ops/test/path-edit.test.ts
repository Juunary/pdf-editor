/**
 * M4 path editing (docs/m4-contract.md section 3, 4.2, 4.3, D2-D4): interpreter optional fields, classification, writing, fingerprint, Form duplication.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { PathEdit, Rect } from '@pdf-editor/shared-types';
import {
  buildSourceMap,
  planPathEdit,
  planPathEditability,
  pathEditWarnings,
  preparePathEdit,
  writePathEdit,
  type ParagraphEditContext,
} from '../src/index.js';
import { constructPoints } from '../src/path-edit.js';
import { latin1String } from '../src/edit-common.js';
import { readStreamBytes } from '../src/mupdf-util.js';
import { loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { bytesOf, expectNoChangeOutside, gridTable, makeDoc } from './helpers/fixtures-m3.js';

beforeAll(async () => {
  await loadModules();
});

const NONE: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};
const edit = (e: Partial<PathEdit>): PathEdit => ({ ...NONE, ...e });

/** Text of the page /Contents joined together. */
function contentText(doc: mupdf.PDFDocument, pageIndex = 0): string {
  const c = doc.findPage(pageIndex).get('Contents');
  const items = c.isArray() ? Array.from({ length: c.length }, (_, i) => c.get(i)) : [c];
  return items.map((s) => latin1String(readStreamBytes(s))).join('\n');
}

const ctxOf = (doc: mupdf.PDFDocument, pageIndex = 0, segments = false) =>
  pageContext(doc, pageIndex, { segments });

/** Classification -> preparation -> one write. */
function apply(
  ctx: ParagraphEditContext,
  paintSeqs: number[],
  e: PathEdit,
): { bbox: Rect; changed: number[] } {
  const plan = planPathEdit(ctx, paintSeqs);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const prep = preparePathEdit(ctx, plan, 'e1');
  const r = writePathEdit(ctx, prep, e);
  return { bbox: r.bbox, changed: prep.changedObjects };
}

const near = (a: readonly number[], b: readonly number[], tol = 0.01) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe('interpreter optional fields (contract section 3)', () => {
  it('pathOps·strokeColorOps·lineWidthOps·operandRanges', () => {
    const doc = makeDoc([
      '1 0 0 RG 2 w 10 10 m 100 10 l S 0 0 1 rg 50 50 40 30 re f 0 0 400 300 re W n',
    ]);
    const map = buildSourceMap(doc, 0);
    const byOp = (name: string) => map.ops.find((o) => o.op === name)!;
    const S = byOp('S');
    expect(S.pathOps!.map((id) => map.ops[id]!.op)).toEqual(['m', 'l']);
    expect(S.state!.strokeColorOps!.map((id) => map.ops[id]!.op)).toEqual(['RG']);
    expect(S.state!.lineWidthOps!.map((id) => map.ops[id]!.op)).toEqual(['w']);
    const f = byOp('f');
    expect(f.pathOps!.map((id) => map.ops[id]!.op)).toEqual(['re']);
    expect(f.state!.fillColorOps.map((id) => map.ops[id]!.op)).toEqual(['rg']);
    // Painting empties the path: W only has the re after it.
    const W = byOp('W');
    expect(W.pathOps!.map((id) => map.ops[id]!.op)).toEqual(['re']);
    const re = byOp('re');
    const bytes = readStreamBytes(doc.findPage(0).get('Contents'));
    expect(re.operandRanges!.map((r) => latin1String(bytes.subarray(r[0], r[1])))).toEqual([
      '50',
      '50',
      '40',
      '30',
    ]);
    // Only number and name operands (including CS/cs names); other kinds are not recorded.
    expect(byOp('w').operandRanges).toHaveLength(1);
    expect(byOp('S').operandRanges).toBeUndefined();
  });

  it('CS + SCN both remain in strokeColorOps', () => {
    const doc = makeDoc(['/DeviceRGB CS 0 1 0 SCN 10 10 m 100 10 l S']);
    const map = buildSourceMap(doc, 0);
    const S = map.ops.find((o) => o.op === 'S')!;
    expect(S.state!.strokeColorOps!.map((id) => map.ops[id]!.op)).toEqual(['CS', 'SCN']);
  });
});

describe('path classification (4.2)', () => {
  const reasonsOf = (content: string, build?: Parameters<typeof makeDoc>[1]) => {
    const doc = makeDoc([content], build);
    return planPathEditability(ctxOf(doc)).map((p) => p.reasons);
  };

  it('simple fill/stroke is editable, n and clip-only are not in the list', () => {
    expect(
      reasonsOf('0 0 1 rg 50 50 40 30 re f 1 0 0 RG 10 10 m 100 10 l S 0 0 400 300 re W n'),
    ).toEqual([[], []]);
  });

  it('B is two PathInfo but one entry', () => {
    const doc = makeDoc(['0 0 1 rg 1 0 0 RG 50 50 40 30 re B']);
    const ctx = ctxOf(doc);
    expect(ctx.model.paths).toHaveLength(2);
    const list = planPathEditability(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]!.editable).toBe(true);
  });

  it('limit reasons', () => {
    expect(reasonsOf('10 10 m 2 w 100 10 l S')).toEqual([['path-interleaved-ops']]);
    expect(reasonsOf('60 60 30 30 re W f')).toEqual([['clip-path']]);
    expect(reasonsOf('BT 10 10 50 50 re f ET')).toEqual([['inside-text-object']]);
    expect(
      reasonsOf('/Pattern cs /P scn 10 10 50 50 re f', (doc) => ({
        Pattern: {
          P: doc.addObject({
            Type: 'Pattern',
            PatternType: 2,
            Shading: {
              ShadingType: 2,
              ColorSpace: 'DeviceRGB',
              Coords: [0, 0, 100, 0],
              Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
            },
          }),
        },
      })),
    ).toEqual([['pattern-or-shading']]);
    expect(
      reasonsOf('q /S1 gs 10 10 50 50 re f Q 100 10 50 50 re f', (doc) => {
        const g = doc.addStream('0.5 g 0 0 300 300 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 300],
          Group: { S: 'Transparency', CS: 'DeviceGray' },
        });
        return { ExtGState: { S1: { SMask: { Type: 'Mask', S: 'Luminosity', G: g } } } };
      }),
    ).toEqual([['soft-mask'], []]);
  });

  it('construction ~ paint spans a /Contents stream boundary', () => {
    const doc = makeDoc(['0 g']);
    const page = doc.findPage(0);
    const arr = doc.newArray();
    arr.push(doc.addStream('10 10 m 100 10 l', {}));
    arr.push(doc.addStream('S 20 20 30 30 re f', {}));
    page.put('Contents', arr);
    const list = planPathEditability(ctxOf(reopen(doc)));
    expect(list.map((p) => p.reasons)).toEqual([['path-spans-streams'], []]);
  });

  it('planPathEdit: color, line width (page-space pt), fingerprint', () => {
    const doc = makeDoc(['q 2 0 0 2 0 0 cm 0 0 1 rg 1 0 0 RG 3 w 10 10 40 30 re B Q']);
    const ctx = ctxOf(doc);
    const [item] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [item!.paintSeq]);
    expect(plan.editable).toBe(true);
    expect(plan.fill!.rgb).toEqual([0, 0, 1]);
    expect(plan.stroke!.rgb).toEqual([1, 0, 0]);
    expect(plan.lineWidth).toBeCloseTo(6, 6);
    expect(plan.target.fingerprints).toHaveLength(1);
    expect(plan.target.fingerprints[0]!.paintOp).toBe('B');
    expect(plan.target.fingerprints[0]!.constructOpCount).toBe(1);
    expect(plan.target.paintSeqs).toEqual([item!.paintSeq]);
  });

  it('optional content gives only a warning', () => {
    const doc = makeDoc(['/OC /L1 BDC 10 10 50 50 re f EMC'], (d) => {
      const ocg = d.addObject({ Type: 'OCG', Name: 'L' });
      d.getTrailer()
        .get('Root')
        .put('OCProperties', d.addObject({ OCGs: [ocg], D: { ON: [ocg] } }));
      return { Properties: { L1: ocg } };
    });
    const ctx = ctxOf(doc);
    const [item] = planPathEditability(ctx);
    expect(item!.editable).toBe(true);
    const plan = planPathEdit(ctx, [item!.paintSeq]);
    expect(plan.warnings.map((w) => w.kind)).toContain('optional-content');
  });
});

describe('path writing (4.3, D3, D4)', () => {
  it('move: rewrites only the re operands and leaves the other bytes as they are', () => {
    const doc = makeDoc(['0 0 1 rg 50 50 40 30 re f 1 0 0 RG 10 10 m 100 10 l S']);
    const before = contentText(doc);
    const ctx = ctxOf(doc);
    const [rect] = planPathEditability(ctx);
    const r = apply(ctx, [rect!.paintSeq], edit({ transform: [1, 0, 0, 1, 10, 0] }));
    const after = contentText(doc);
    expect(after).toBe(before.replace('50 50 40 30 re', '60 50 40 30 re'));
    const moved = ctxOf(reopen(doc)).model.paths[0]!.bbox;
    expect(
      near(moved, [rect!.bbox[0] + 10, rect!.bbox[1], rect!.bbox[2] + 10, rect!.bbox[3]]),
    ).toBe(true);
    expect(near(r.bbox, moved)).toBe(true);
  });

  it('size: non-uniform scaling keeps re, line width unchanged', () => {
    const doc = makeDoc(['1 0 0 RG 4 w 50 50 40 30 re S']);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    // 2x and 1x relative to page-space (x0,y0).
    const [x0, y0] = [p!.bbox[0] + 2, p!.bbox[1] + 2];
    apply(ctx, [p!.paintSeq], edit({ transform: [2, 0, 0, 1, -x0, 0] }));
    void y0;
    expect(contentText(doc)).toMatch(/50 50 80 30 re/);
    expect(contentText(doc)).toMatch(/4 w/);
  });

  it('color (D3): DeviceRGB, Gray, CMYK; the same color is not written; saturation on Gray gives RGB + warning', () => {
    const doc = makeDoc([
      '0 0 1 rg 10 10 20 20 re f 0.5 g 40 10 20 20 re f 0 0 0 1 k 70 10 20 20 re f 0.5 g 100 10 20 20 re f',
    ]);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    const seqs = list.map((p) => p.paintSeq);
    const plan = planPathEdit(ctx, seqs.slice(0, 3));
    const prep = preparePathEdit(ctx, plan, 'c');
    writePathEdit(ctx, prep, edit({ fill: [1, 1, 1] }));
    const t = contentText(doc);
    expect(t).toContain('q 1 1 1 rg 10 10 20 20 re f Q');
    expect(t).toContain('q 1 g 40 10 20 20 re f Q');
    expect(t).toContain('q 0 0 0 0 k 70 10 20 20 re f Q');
    expect(pathEditWarnings(ctx, prep)).toEqual([]);
    // Rewriting the same draft: based on the original, so the earlier write does not remain.
    writePathEdit(ctx, prep, edit({ fill: [1, 0, 0] }));
    const t2 = contentText(doc);
    expect(t2).toContain('q 1 0 0 rg 10 10 20 20 re f Q');
    expect(t2).toContain('q 1 0 0 rg 40 10 20 20 re f Q');
    expect(t2).not.toContain('1 1 1 rg');
    expect(pathEditWarnings(ctx, prep).map((w) => w.kind)).toEqual(['color-space-changed']);
    // If equal to the original color at 8 bits, it is not written.
    writePathEdit(ctx, prep, edit({ fill: [0, 0, 1] }));
    expect(contentText(doc)).toMatch(/^0 0 1 rg 10 10 20 20 re f 0\.5 g q 0 0 1 rg 40/);
  });

  it('line width: page pt -> content space (sqrt|det|), not written for fill-only paths', () => {
    const doc = makeDoc(['q 2 0 0 2 0 0 cm 1 0 0 RG 1 w 10 10 m 50 10 l S 10 20 20 20 re f Q']);
    const ctx = ctxOf(doc);
    const seqs = planPathEditability(ctx).map((p) => p.paintSeq);
    apply(ctx, seqs, edit({ lineWidth: 4 }));
    const t = contentText(doc);
    expect(t).toContain('q 2 w 10 10 m 50 10 l S Q');
    expect(t).toContain('Q 10 20 20 20 re f Q');
    expect(t).not.toContain('q 2 w 10 20');
  });

  it('delete: replaces construction ~ paint with blanks (no unpaired n), other paths unchanged (three engines)', async () => {
    const doc = makeDoc([
      '0 0 1 rg 50 50 40 30 re f 1 0 0 RG 10 10 m 100 10 l S 200 200 20 20 re f',
    ]);
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    const r = apply(ctx, [list[1]!.paintSeq], edit({ delete: true }));
    expect(contentText(doc)).toBe('0 0 1 rg 50 50 40 30 re f 1 0 0 RG   200 200 20 20 re f');
    expect(contentText(doc)).not.toMatch(/(^|\s)n(\s|$)/);
    const again = ctxOf(reopen(doc));
    expect(again.model.paths).toHaveLength(2);
    // The paintSeq of later paths is pulled forward by one, and classification and editing can continue.
    const next = planPathEditability(again);
    expect(next.map((p) => p.paintSeq)).toEqual([list[0]!.paintSeq, list[1]!.paintSeq]);
    expect(next.every((p) => p.editable)).toBe(true);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [r.bbox]);
  });

  it('delete: inside a Form, between q/Q, and consecutive deletes also leave only blanks and the render is the same (three engines)', async () => {
    const doc = makeDoc(
      ['q 1 0 0 RG 3 w 20 20 m 120 20 l S Q 0 1 0 rg 150 150 40 40 re f q /X0 Do Q'],
      (d) => ({
        XObject: {
          X0: d.addStream('0 0 1 rg 10 200 30 30 re f 1 0 0 rg 60 200 30 30 re f', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 400, 300],
            Resources: {},
          }),
        },
      }),
    );
    const before = bytesOf(doc);
    let ctx = ctxOf(doc);
    const first = planPathEditability(ctx)[0]!;
    const r1 = apply(ctx, [first.paintSeq], edit({ delete: true }));
    // Continuing on the same document: delete the first path inside the Form (the duplicate).
    const doc2 = reopen(doc);
    ctx = ctxOf(doc2);
    const inForm = planPathEditability(ctx).find((p) => p.bbox[0] < 15 && p.bbox[1] < 100)!;
    const r2 = apply(ctx, [inForm.paintSeq], edit({ delete: true }));
    expect(contentText(doc2)).toMatch(
      /^q 1 0 0 RG 3 w +Q 0 1 0 rg 150 150 40 40 re f q \/PEF0 Do Q$/,
    );
    const clone = doc2.findPage(0).get('Resources').get('XObject').get('PEF0');
    expect(latin1String(readStreamBytes(clone))).toBe('0 0 1 rg   1 0 0 rg 60 200 30 30 re f');
    // Without the Form BBox clip PathInfo, there are 2 painted paths.
    expect(ctxOf(reopen(doc2)).model.paths.filter((p) => p.op !== 'clip')).toHaveLength(2);
    await expectNoChangeOutside(before, bytesOf(doc2), 0, [r1.bbox, r2.bbox]);
  });

  it('multiple selection: the same move for all targets', () => {
    const doc = makeDoc(['10 10 20 20 re f 50 10 20 20 re f 90 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    apply(ctx, [list[0]!.paintSeq, list[2]!.paintSeq], edit({ transform: [1, 0, 0, 1, 0, -5] }));
    // 5 up in page space = user space y + 5.
    expect(contentText(doc)).toBe('10 15 20 20 re f 50 10 20 20 re f 90 15 20 20 re f');
  });

  it('point edit: one point of re -> m l l l h, corresponding to the model segments', () => {
    const doc = makeDoc(['50 50 40 30 re f']);
    const ctx = ctxOf(doc, 0, true);
    const info = ctx.model.paths[0]!;
    expect(info.segments!.map((s) => s.type)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    const [p] = planPathEditability(ctx);
    // Point 2 = (x+w, y+h), user space (90, 80) -> page (90, 300-80).
    apply(ctx, [p!.paintSeq], edit({ points: [{ index: 2, to: [100, 200] }] }));
    expect(contentText(doc)).toBe('50 50 m 90 50 l 100 100 l 50 80 l h f');
  });

  it('point edit: moving the first point (current point) of v gives c, and y gives c if the second point differs from the third', () => {
    const doc = makeDoc(['10 10 m 20 30 40 10 v 60 30 80 10 y S']);
    const ctx = ctxOf(doc, 0, true);
    const info = ctx.model.paths[0]!;
    const segs = info.segments!;
    const mine = constructPoints([
      { op: 'm', nums: [10, 10] },
      { op: 'v', nums: [20, 30, 40, 10] },
      { op: 'y', nums: [60, 30, 80, 10] },
    ]);
    expect(segs).toEqual(mine.segments);
    const [p] = planPathEditability(ctx);
    // Point 1 = first control point of v (current point 10,10), point 5 = second point of y (= end point 80,10).
    apply(
      ctx,
      [p!.paintSeq],
      edit({
        points: [
          { index: 1, to: [12, 300 - 12] },
          { index: 5, to: [70, 300 - 20] },
        ],
      }),
    );
    expect(contentText(doc)).toBe('10 10 m 12 12 20 30 40 10 c 60 30 70 20 80 10 c S');
  });

  it('point edit allows only one target', () => {
    const doc = makeDoc(['10 10 20 20 re f 50 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const seqs = planPathEditability(ctx).map((p) => p.paintSeq);
    const plan = planPathEdit(ctx, seqs);
    const prep = preparePathEdit(ctx, plan, 'p');
    expect(() => writePathEdit(ctx, prep, edit({ points: [{ index: 0, to: [0, 0] }] }))).toThrow(
      /하나만/,
    );
  });

  it('rotation transforms are rejected (only move and scale)', () => {
    const doc = makeDoc(['10 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [p!.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 'r');
    expect(() => writePathEdit(ctx, prep, edit({ transform: [0, 1, -1, 0, 0, 0] }))).toThrow();
  });

  it('a fingerprint mismatch fails preparation (does not modify another path)', () => {
    const doc = makeDoc(['10 10 20 20 re f 50 10 20 20 re f']);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [list[0]!.paintSeq]);
    // In a document with the earlier path deleted, the same paintSeq points to a different path.
    const doc2 = makeDoc(['50 10 20 20 re f']);
    const ctx2 = ctxOf(doc2);
    expect(() => preparePathEdit(ctx2, plan, 'x')).toThrow(/지문/);
  });

  it('path-clipped: warning when moved outside the rectangular clip', () => {
    const doc = makeDoc(['q 0 0 100 100 re W n 10 10 20 20 re f Q']);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [p!.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 'k');
    writePathEdit(ctx, prep, edit({ transform: [1, 0, 0, 1, 200, 0] }));
    expect(pathEditWarnings(ctx, prep).map((w) => w.kind)).toEqual(['path-clipped']);
  });

  it('inside a Form: changes only this usage site, and two paths of the same Form share one duplicate', async () => {
    const doc = makeDoc(['q /X0 Do Q q 1 0 0 1 150 0 cm /X0 Do Q'], (d) => ({
      XObject: {
        X0: d.addStream('0 0 1 rg 10 10 20 20 re f 1 0 0 rg 40 10 20 20 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: {},
        }),
      },
    }));
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const list = planPathEditability(ctx);
    expect(list).toHaveLength(4);
    const plan = planPathEdit(ctx, [list[0]!.paintSeq, list[1]!.paintSeq]);
    expect(plan.warnings.map((w) => w.kind)).toContain('shared-form');
    const prep = preparePathEdit(ctx, plan, 'f');
    const r = writePathEdit(ctx, prep, edit({ fill: [0, 1, 0] }));
    // Page + page content + 1 duplicate.
    const t = contentText(doc);
    expect(t).toMatch(/^q \/PEF0 Do Q q 1 0 0 1 150 0 cm \/X0 Do Q$/);
    const again = ctxOf(reopen(doc));
    const greens = again.model.paths.filter((p) => p.color?.rgb?.join() === '0,1,0');
    expect(greens).toHaveLength(2);
    expect(again.model.paths.filter((p) => p.color?.rgb?.join() === '0,0,1')).toHaveLength(1);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [r.bbox]);
  });

  it('the page usage count cache is recounted for each classification (ctx): shared-form is reflected after the document changes (review L5)', () => {
    const doc = makeDoc(['q /X0 Do Q', { content: '', resources: { XObject: {} } }], (d) => ({
      XObject: {
        X0: d.addStream('0 0 1 rg 10 10 20 20 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: {},
        }),
      },
    }));
    const kinds = () => {
      const ctx = ctxOf(doc);
      const list = planPathEditability(ctx);
      return planPathEdit(ctx, [list[0]!.paintSeq]).warnings.map((w) => w.kind);
    };
    expect(kinds()).not.toContain('shared-form');
    const x0 = doc.findPage(0).getInheritable('Resources').get('XObject').get('X0');
    doc.findPage(1).getInheritable('Resources').get('XObject').put('X0', x0);
    expect(kinds()).toContain('shared-form');
  });

  it('re-editing a path in the same Form deletes the previous duplicate name (review L2)', () => {
    const doc = makeDoc(['q /X0 Do Q'], (d) => ({
      XObject: {
        X0: d.addStream('0 0 1 rg 10 10 20 20 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: {},
        }),
      },
    }));
    const names = (d: mupdf.PDFDocument) => {
      const out: string[] = [];
      d.findPage(0)
        .getInheritable('Resources')
        .get('XObject')
        .forEach((_v, k) => out.push(String(k)));
      return out.sort();
    };
    let cur = doc;
    for (let i = 0; i < 3; i++) {
      const ctx = ctxOf(cur);
      const list = planPathEditability(ctx);
      const plan = planPathEdit(ctx, [list[0]!.paintSeq]);
      const prep = preparePathEdit(ctx, plan, `e${i}`);
      writePathEdit(ctx, prep, edit({ fill: [0, i === 1 ? 1 : 0.5, 0] }));
      cur = reopen(cur);
    }
    // The original X0 is no longer used anywhere, and only one duplicate name remains.
    expect(names(cur).filter((n) => n.startsWith('PEF'))).toHaveLength(1);
    expect(contentText(cur)).toMatch(/^q \/PEF\d+ Do Q$/);
  });

  it('Form without Resources (inherits from the page): the duplicate holds a copy of the page Resources and the text render is unchanged (three engines)', async () => {
    const doc = makeDoc(['q /X0 Do Q'], (d) => ({
      XObject: {
        X0: d.addStream('BT /F2 24 Tf 10 50 Td (Hello) Tj ET 0 0 1 rg 10 10 20 20 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 200, 100],
        }),
      },
    }));
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    const r = apply(ctx, [p!.paintSeq], edit({ fill: [0, 1, 0] }));
    const xo = doc.findPage(0).get('Resources').get('XObject');
    const clone = xo.get('PEF0').resolve();
    expect(clone.get('Resources').get('Font').get('F2').isNull()).toBe(false);
    // The duplicate Resources is an object different from the page dictionary (registering PEF0 on the page does not add it to the duplicate).
    expect(clone.get('Resources').get('XObject').get('PEF0').isNull()).toBe(true);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [r.bbox]);
  });

  it('Form without Resources (inherits from the parent Form): uses a copy of the Resources of the parent duplicate (three engines)', async () => {
    const doc = makeDoc(['q /X0 Do Q'], (d, f) => {
      const inner = d.addStream('BT /FX 24 Tf 10 50 Td (Inner) Tj ET 0 0 1 rg 10 10 20 20 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 100],
      });
      return {
        XObject: {
          X0: d.addStream('BT /FX 18 Tf 10 120 Td (Outer) Tj ET q 1 0 0 1 0 0 cm /In Do Q', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 300, 200],
            Resources: { Font: { FX: f.F1 }, XObject: { In: inner } },
          }),
        },
      };
    });
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const [p] = planPathEditability(ctx);
    expect(p!.editable).toBe(true);
    const r = apply(ctx, [p!.paintSeq], edit({ fill: [0, 1, 0] }));
    const outer = doc.findPage(0).get('Resources').get('XObject').get('PEF0').resolve();
    const inner = outer.get('Resources').get('XObject').get('PEF0').resolve();
    expect(inner.get('Resources').get('Font').get('FX').isNull()).toBe(false);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [r.bbox]);
  });

  it('a shared /Contents stream is copied', () => {
    const src = new mupdf.PDFDocument();
    const shared = src.addStream('10 10 20 20 re f', {});
    for (let i = 0; i < 2; i++) {
      src.insertPage(-1, src.addPage([0, 0, 400, 300], 0, {}, ''));
      src.findPage(i).put('Contents', shared);
    }
    const doc = reopen(src);
    const ctx = ctxOf(doc, 0);
    const [p] = planPathEditability(ctx);
    apply(ctx, [p!.paintSeq], edit({ transform: [1, 0, 0, 1, 5, 0] }));
    expect(contentText(doc, 0)).toBe('15 10 20 20 re f');
    expect(contentText(doc, 1)).toBe('10 10 20 20 re f');
  });

  it('deleting a path inside a tag (MCID) warns, while paths outside tags and moves do not warn (review L8)', () => {
    const doc = makeDoc([
      '/Figure << /MCID 0 >> BDC 1 0 0 rg 10 10 20 20 re f EMC 0 0 1 rg 50 50 20 20 re f',
    ]);
    const warn = (seq: number, e: Partial<PathEdit>) => {
      const ctx = ctxOf(doc);
      const list = planPathEditability(ctx);
      const plan = planPathEdit(ctx, [list[seq]!.paintSeq]);
      const prep = preparePathEdit(ctx, plan, `w${seq}${e.delete ? 'd' : 'm'}`);
      writePathEdit(ctx, prep, edit(e));
      return pathEditWarnings(ctx, prep).map((w) => w.kind);
    };
    expect(warn(0, { transform: [1, 0, 0, 1, 5, 0] })).toEqual([]);
    expect(warn(1, { delete: true })).toEqual([]);
    expect(warn(0, { delete: true })).toEqual(['tagged-structure-unlinked']);
  });

  it('table rule deletion warning (table-rule-removed)', () => {
    const doc = makeDoc([{ content: gridTable(), mediabox: [0, 0, 500, 300] }]);
    const ctx = ctxOf(doc, 0, true);
    expect(ctx.layout.tables.map((t) => t.strategy)).toEqual(['lines']);
    const [p] = planPathEditability(ctx);
    const plan = planPathEdit(ctx, [p!.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 't');
    writePathEdit(ctx, prep, edit({ delete: true }));
    expect(pathEditWarnings(ctx, prep).map((w) => w.kind)).toEqual(['table-rule-removed']);
  });

  it('a path not in LayoutTable.paths does not raise table-rule-removed even if it overlaps the table box', () => {
    // A short diagonal line crossing the upper-right corner of the table (neither a rule line nor a background rectangle). The previous rule (overlap within 1pt of the table box) would have warned.
    const content = `${gridTable()} 395 205 m 410 190 l S`;
    const doc = makeDoc([{ content, mediabox: [0, 0, 500, 300] }]);
    const ctx = ctxOf(doc, 0, true);
    const [table] = ctx.layout.tables;
    expect(table!.strategy).toBe('lines');
    expect(table!.paths).toHaveLength(8);
    const paths = planPathEditability(ctx);
    const diagonal = paths.at(-1)!;
    expect(table!.paths).not.toContain(diagonal.pathIndex);
    const plan = planPathEdit(ctx, [diagonal.paintSeq]);
    const prep = preparePathEdit(ctx, plan, 'd');
    writePathEdit(ctx, prep, edit({ delete: true }));
    expect(pathEditWarnings(ctx, prep)).toEqual([]);
  });
});

describe('V2/V3 synthesis (three engines)', () => {
  const content = [
    '0.2 0.4 0.6 rg 1 0 0 RG 1.5 w',
    '10.123456789012 20.987654321098 m 120.5 40.25 l 60.333333333333 90.666666666667 30.1 70.2 15 50 c h B',
    '200 20 m 230 80 260 20 v 290 80 320 20 y S',
    'q 0.8 0 0 0.8 20 140 cm 0 0 0 rg 0 0 80.123456789 40.987654321 re f Q',
    '0.5 g 150 150 m 220 150 l 220 220 l h f*',
  ].join(' ');

  it('V2: the render is the same even when wrapping each paint in q ... Q', async () => {
    const doc = makeDoc([content]);
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const ops = ctx.map.ops;
    const bytes = readStreamBytes(doc.findPage(0).get('Contents'));
    const reps: { start: number; end: number; text: string }[] = [];
    for (const p of planPathEditability(ctx)) {
      const paint = ops[ctx.linkage.pathOp[p.pathIndex]!]!;
      const first = ops[paint.pathOps![0]!]!;
      reps.push({ start: first.range[0], end: first.range[0], text: 'q ' });
      reps.push({ start: paint.range[1], end: paint.range[1], text: ' Q' });
    }
    expect(reps).toHaveLength(8);
    const { applyReplacements } = await import('../src/text-remove.js');
    doc.findPage(0).get('Contents').writeStream(applyReplacements(bytes, reps));
    await expectNoChangeOutside(before, bytesOf(doc), 0, []);
  });

  it('V3: the render is the same even when rewriting construction operation operands to 9 digits', async () => {
    const doc = makeDoc([content]);
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    // The same coordinates are not written because no operation changed, so all construction operations are rewritten with a 1e-12pt move (multiple selection).
    const seqs = planPathEditability(ctx).map((p) => p.paintSeq);
    const plan = planPathEdit(ctx, seqs);
    writePathEdit(
      ctx,
      preparePathEdit(ctx, plan, 'v3'),
      edit({ transform: [1, 0, 0, 1, 1e-12, 0] }),
    );
    expect(contentText(doc)).toContain('80.1234568 40.9876543 re');
    expect(contentText(doc)).toContain('230 80 260 20 v 290 80 320 20 y');
    expect(contentText(doc)).toMatch(
      /^0\.2 0\.4 0\.6 rg 1 0 0 RG 1\.5 w 10\.1234568 20\.9876543 m/,
    );
    await expectNoChangeOutside(before, bytesOf(doc), 0, []);
  });
});
