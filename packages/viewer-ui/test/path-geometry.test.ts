import type { PathSegment } from '@pdf-editor/shared-types';
import { describe, expect, it } from 'vitest';
import {
  boxTransform,
  buildCandidates,
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

describe('후보 묶기', () => {
  it('판정 목록에 없는 PathInfo 는 뺀다', () => {
    const a = makePath(1, [0, 0, 10, 10]);
    const clip = makePath(2, [0, 0, 5, 5], { op: 'clip' });
    const cands = buildCandidates([a, clip], [makeEditability(0, a)]);
    expect(cands.map((c) => c.paintSeq)).toEqual([1]);
  });

  it('같은 paintSeq 의 채움·선 PathInfo 는 한 후보다', () => {
    const fill = makePath(3, [0, 0, 10, 10]);
    const stroke = makePath(3, [0, 0, 10, 10], { op: 'stroke', lineWidth: 1, color: null });
    const cands = buildCandidates([fill, stroke], [makeEditability(0, fill)]);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.infos).toHaveLength(2);
  });
});

describe('맞음 판정', () => {
  it('채움은 안쪽만 맞고 바깥은 허용 거리가 있어도 맞지 않는다', () => {
    const f = makePath(1, [10, 10, 50, 50]);
    const [c] = buildCandidates([f], [makeEditability(0, f)]);
    expect(candidateHit(c!, [30, 30], 2)).toBe(true);
    expect(candidateHit(c!, [52, 30], 2)).toBe(false);
  });

  it('선은 허용 거리 안(+선 두께 절반)에서 맞고 안쪽 빈 곳은 맞지 않는다', () => {
    const s = makePath(1, [10, 10, 50, 50], { op: 'stroke', lineWidth: 2, color: null });
    const [c] = buildCandidates([s], [makeEditability(0, s)]);
    expect(candidateHit(c!, [10, 30], 0)).toBe(true);
    expect(candidateHit(c!, [13, 30], 3)).toBe(true);
    expect(candidateHit(c!, [30, 30], 3)).toBe(false);
  });

  it('even-odd 구멍은 안쪽이 아니다', () => {
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
    expect(insideFill(flattenPath(p), [50, 50], false)).toBe(true); // 같은 방향이면 감김 2(0 아님)
  });

  it('겹치면 가장 작은 패스를 고른다', () => {
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

  it('segments 가 없으면 상자로 근사한다', () => {
    const f = makePath(1, [0, 0, 10, 10], { segments: null });
    const [c] = buildCandidates([f], [makeEditability(0, f)]);
    expect(candidateHit(c!, [5, 5], 0)).toBe(true);
  });

  it('CTM 을 적용한 위치에서 맞는다', () => {
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

describe('상자 변환', () => {
  it('모서리 핸들: 반대 모서리가 고정되고, Shift 면 비율이 유지된다', () => {
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

  it('변 핸들은 한 축만, 최소 크기를 넘어 뒤집히지 않는다', () => {
    expect(resizeBox([0, 0, 100, 50], 'e', -500, 7, true)).toEqual([0, 0, 1, 50]);
    expect(resizeBox([0, 0, 100, 50], 'n', 9, 60, false)).toEqual([0, 49, 100, 50]);
  });

  it('boxTransform 은 from 을 to 로 보낸다', () => {
    const m = boxTransform([10, 10, 30, 20], [0, 0, 40, 40]);
    expect(transformRect(m, [10, 10, 30, 20])).toEqual([0, 0, 40, 40]);
    expect(isIdentity(boxTransform([1, 2, 3, 4], [1, 2, 3, 4]))).toBe(true);
    expect(translateBox([0, 0, 1, 1], 5, -2)).toEqual([5, -2, 6, -1]);
  });
});

describe('점 번호', () => {
  it('M·L 은 1개, C 는 제어점 2개 + 끝점 1개이며 0 부터 센다', () => {
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
