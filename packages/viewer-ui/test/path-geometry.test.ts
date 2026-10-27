import type { PathSegment } from '@pdf-editor/shared-types';
import { describe, expect, it } from 'vitest';
import {
  boxTransform,
  buildCandidates,
  companionPoints,
  candidateHit,
  flattenPath,
  insideFill,
  isIdentity,
  pathPoints,
  pickPath,
  resizeBox,
  transformRect,
  translateBox,
} from '../src/path-geometry.js';
import { makeEditability, makePath } from './path-fixtures.js';

describe('candidate grouping', () => {
  it('drops PathInfo not in the classification list', () => {
    const a = makePath(1, [0, 0, 10, 10]);
    const clip = makePath(2, [0, 0, 5, 5], { op: 'clip' });
    const cands = buildCandidates([a, clip], [makeEditability(0, a)]);
    expect(cands.map((c) => c.paintSeq)).toEqual([1]);
  });

  it('fill and stroke PathInfo with the same paintSeq form one candidate', () => {
    const fill = makePath(3, [0, 0, 10, 10]);
    const stroke = makePath(3, [0, 0, 10, 10], { op: 'stroke', lineWidth: 1, color: null });
    const cands = buildCandidates([fill, stroke], [makeEditability(0, fill)]);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.infos).toHaveLength(2);
  });
});

describe('hit test', () => {
  it('a fill hits only on the inside, and the outside does not hit even within the tolerance distance', () => {
    const f = makePath(1, [10, 10, 50, 50]);
    const [c] = buildCandidates([f], [makeEditability(0, f)]);
    expect(candidateHit(c!, [30, 30], 2)).toBe(true);
    expect(candidateHit(c!, [52, 30], 2)).toBe(false);
  });

  it('a stroke hits within the tolerance distance (+ half the line width), and an empty inside does not hit', () => {
    const s = makePath(1, [10, 10, 50, 50], { op: 'stroke', lineWidth: 2, color: null });
    const [c] = buildCandidates([s], [makeEditability(0, s)]);
    expect(candidateHit(c!, [10, 30], 0)).toBe(true);
    expect(candidateHit(c!, [13, 30], 3)).toBe(true);
    expect(candidateHit(c!, [30, 30], 3)).toBe(false);
  });

  it('an even-odd hole is not inside', () => {
    const outer: PathSegment[] = [
      { type: 'M', p: [0, 0] },
      { type: 'L', p: [100, 0] },
      { type: 'L', p: [100, 100] },
      { type: 'L', p: [0, 100] },
      { type: 'Z' },
      { type: 'M', p: [40, 40] },
      { type: 'L', p: [60, 40] },
      { type: 'L', p: [60, 60] },
      { type: 'L', p: [40, 60] },
      { type: 'Z' },
    ];
    const p = makePath(1, [0, 0, 100, 100], { evenOdd: true, segments: outer });
    expect(insideFill(flattenPath(p), [50, 50], true)).toBe(false);
    expect(insideFill(flattenPath(p), [10, 10], true)).toBe(true);
    expect(insideFill(flattenPath(p), [50, 50], false)).toBe(true); // same direction gives winding 2 (not 0)
  });

  it('when overlapping, picks the smallest path', () => {
    const big = makePath(1, [0, 0, 100, 100]);
    const small = makePath(2, [40, 40, 60, 60]);
    const cands = buildCandidates(
      [big, small],
      [makeEditability(0, big), makeEditability(1, small)],
    );
    expect(pickPath(cands, [50, 50], 1)?.paintSeq).toBe(2);
    expect(pickPath(cands, [10, 10], 1)?.paintSeq).toBe(1);
    expect(pickPath(cands, [200, 200], 1)).toBeNull();
  });

  it('without segments, approximates with the box', () => {
    const f = makePath(1, [0, 0, 10, 10], { segments: null });
    const [c] = buildCandidates([f], [makeEditability(0, f)]);
    expect(candidateHit(c!, [5, 5], 0)).toBe(true);
  });

  it('hits at the position with the CTM applied', () => {
    const f = makePath(1, [100, 100, 120, 120], {
      ctm: [2, 0, 0, 2, 100, 0],
      segments: [
        { type: 'M', p: [0, 0] },
        { type: 'L', p: [10, 0] },
        { type: 'L', p: [10, 10] },
        { type: 'L', p: [0, 10] },
        { type: 'Z' },
      ],
    });
    const [c] = buildCandidates([f], [makeEditability(0, f)]);
    expect(candidateHit(c!, [110, 10], 0)).toBe(true);
    expect(candidateHit(c!, [5, 5], 0)).toBe(false);
  });
});

describe('box transform', () => {
  it('corner handle: the opposite corner is fixed, and Shift keeps the aspect ratio', () => {
    const box: [number, number, number, number] = [0, 0, 100, 50];
    expect(resizeBox(box, 'se', 20, 5, false)).toEqual([0, 0, 120, 55]);
    const kept = resizeBox(box, 'se', 100, 0, true);
    expect(kept[0]).toBe(0);
    expect(kept[1]).toBe(0);
    expect((kept[2] - kept[0]) / (kept[3] - kept[1])).toBeCloseTo(2);
    const nw = resizeBox(box, 'nw', -10, -10, true);
    expect(nw[2]).toBe(100);
    expect(nw[3]).toBe(50);
    expect((nw[2] - nw[0]) / (nw[3] - nw[1])).toBeCloseTo(2);
  });

  it('an edge handle affects only one axis and does not flip past the minimum size', () => {
    expect(resizeBox([0, 0, 100, 50], 'e', -500, 7, true)).toEqual([0, 0, 1, 50]);
    expect(resizeBox([0, 0, 100, 50], 'n', 9, 60, false)).toEqual([0, 49, 100, 50]);
  });

  it('boxTransform maps from to to', () => {
    const m = boxTransform([10, 10, 30, 20], [0, 0, 40, 40]);
    expect(transformRect(m, [10, 10, 30, 20])).toEqual([0, 0, 40, 40]);
    expect(isIdentity(boxTransform([1, 2, 3, 4], [1, 2, 3, 4]))).toBe(true);
    expect(translateBox([0, 0, 1, 1], 5, -2)).toEqual([5, -2, 6, -1]);
  });
});

describe('point numbering', () => {
  it('M and L are 1 point, C is 2 control points + 1 end point, counted from 0', () => {
    const p = makePath(1, [0, 0, 30, 30], {
      op: 'stroke',
      lineWidth: 1,
      color: null,
      ctm: [1, 0, 0, 1, 10, 0],
      segments: [
        { type: 'M', p: [0, 0] },
        { type: 'C', p1: [5, 0], p2: [10, 5], p3: [10, 10] },
        { type: 'L', p: [0, 10] },
        { type: 'Z' },
      ],
    });
    const pts = pathPoints(p);
    expect(pts.map((q) => [q.index, q.kind])).toEqual([
      [0, 'anchor'],
      [1, 'control'],
      [2, 'control'],
      [3, 'anchor'],
      [4, 'anchor'],
    ]);
    expect(pts[0]!.p).toEqual([10, 0]);
    expect(pts[1]!.anchor).toEqual([10, 0]);
    expect(pts[2]!.anchor).toEqual([20, 10]);
  });
});

describe('attached control points (review L3)', () => {
  const curve = (segments: PathSegment[]) =>
    pathPoints(
      makePath(1, [0, 0, 100, 100], { op: 'stroke', lineWidth: 1, color: null, segments }),
    );

  it('moving the y end point makes the overlapping second control point follow', () => {
    const pts = curve([
      { type: 'M', p: [0, 0] },
      { type: 'C', p1: [10, 0], p2: [50, 50], p3: [50, 50] },
    ]);
    expect(companionPoints(pts, 3).map((c) => c.index)).toEqual([2]);
    expect(companionPoints(pts, 2)).toEqual([]); // dragging a control point directly is solo
  });

  it('moving the leading vertex of v makes the overlapping first control point follow', () => {
    const pts = curve([
      { type: 'M', p: [0, 0] },
      { type: 'C', p1: [0, 0], p2: [30, 40], p3: [50, 50] },
    ]);
    expect(companionPoints(pts, 0).map((c) => c.index)).toEqual([1]);
  });

  it('a general curve with no overlap is solo', () => {
    const pts = curve([
      { type: 'M', p: [0, 0] },
      { type: 'C', p1: [10, 0], p2: [40, 50], p3: [50, 50] },
    ]);
    expect(companionPoints(pts, 0)).toEqual([]);
    expect(companionPoints(pts, 3)).toEqual([]);
  });
});
