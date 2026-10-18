/**
 * PageModel ↔ SourceMap 매칭(docs/m1-contract.md 3절).
 *
 * - 글자: 같은 glyphSeq 끼리 짝짓고 원점 오차가 허용치 이하인지 확인한다. 어긋나면 번호 차이(delta)를
 *   창 안에서 원점으로 다시 찾고, 다음 글자까지 같은 delta 로 맞을 때만 재동기화한다.
 * - 도형: 같은 paintSeq 끼리 짝짓고 종류 호환·행렬(경로)·경계(이미지)로 확인한다. 재동기화는 글자와 같다.
 * - 폭 정보가 불완전한 폰트(font-encoding-unresolved) 글리프는 원점이 어긋날 수 있어, 직전 글자와 번호가
 *   이어지면 원점 확인 없이 인정한다(재동기화 기준으로는 쓰지 않는다).
 * - 실패한 글자·도형은 -1. 짝이 없는 번호를 가진 연산에는 `unmatched` 제한을 단다(map 을 고친다).
 */
import type {
  ImageInfo,
  LinkStats,
  Matrix,
  PageLinkage,
  PageModel,
  PathInfo,
  Point,
  ShadeInfo,
  SourceMap,
  SourceOp,
} from '@pdf-editor/shared-types';
import { now } from './clock.js';

export interface LinkConfig {
  originTolerance: number;
  /** 재동기화 탐색 창(번호 차이). */
  window: number;
}

interface MapGlyph {
  op: number;
  glyph: number;
  origin: Point;
  loose: boolean;
}

interface MapPaint {
  op: SourceOp;
  /** 같은 연산의 몇 번째 paintSeq 인지. */
  index: number;
}

type ModelPaint =
  | { kind: 'path'; i: number; item: PathInfo }
  | { kind: 'image'; i: number; item: ImageInfo }
  | { kind: 'shade'; i: number; item: ShadeInfo };

function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function sameMatrix(a: Matrix, b: Matrix): boolean {
  const scale = Math.max(1, ...a.map(Math.abs), ...b.map(Math.abs));
  return a.every((v, i) => Math.abs(v - b[i]!) <= 1e-3 * scale);
}

function unitBox(m: Matrix): [number, number, number, number] {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * 순서 정렬: model[i] 의 번호 seq(i) 를 map 번호 seq(i)+delta 와 짝짓는다.
 * - map 쪽이 주인 없는 번호(구멍: 패턴 셀 내용 등)면 그 항목은 매칭하지 않고 delta 를 유지한다.
 * - 주인 있는 번호와 맞지 않으면 창 안에서 delta 를 다시 찾는다. 후보 delta 는 이어지는 항목
 *   (구멍이 아닌 것) 최대 2개가 같은 delta 로 strong 하게 맞아야 채택한다.
 */
function align(
  count: number,
  seqOf: (i: number) => number,
  has: (j: number) => boolean,
  mapSize: number,
  accept: (
    i: number,
    j: number,
    prev: { i: number; j: number } | null,
  ) => 'strong' | 'loose' | null,
  windowSize: number,
): number[] {
  const out = new Array<number>(count).fill(-1);
  const used = new Uint8Array(Math.max(0, mapSize));
  let delta = 0;
  let prev: { i: number; j: number } | null = null;
  const free = (j: number) => j >= 0 && j < mapSize && used[j] === 0;
  const ok = (i: number, j: number) => (free(j) ? accept(i, j, prev) : null);
  const confirm = (i: number, d: number, j: number): boolean => {
    const saved = prev;
    prev = { i, j };
    let checked = 0;
    let good = true;
    for (let n = i + 1; n < count && checked < 2; n++) {
      const nj = seqOf(n) + d;
      if (nj >= 0 && nj < mapSize && !has(nj)) continue;
      checked++;
      if (nj === j || !free(nj) || accept(n, nj, prev) !== 'strong') {
        good = false;
        break;
      }
      prev = { i: n, j: nj };
    }
    prev = saved;
    return good;
  };
  for (let i = 0; i < count; i++) {
    const s = seqOf(i);
    let j = s + delta;
    if (j >= 0 && j < mapSize && !has(j)) {
      prev = null;
      continue;
    }
    let hit = ok(i, j);
    if (!hit) {
      for (let k = 1; k <= windowSize && !hit; k++) {
        for (const d of [delta + k, delta - k]) {
          const jj = s + d;
          if (!has(jj) || ok(i, jj) !== 'strong' || !confirm(i, d, jj)) continue;
          delta = d;
          j = jj;
          hit = 'strong';
          break;
        }
      }
    }
    if (hit) {
      out[i] = j;
      used[j] = 1;
      prev = { i, j };
    } else prev = null;
  }
  return out;
}

export function link(model: PageModel, map: SourceMap, config: LinkConfig): PageLinkage {
  const t0 = now();
  const tol = config.originTolerance;

  // 글자
  const glyphs: (MapGlyph | undefined)[] = new Array(map.glyphCount);
  for (const op of map.ops) {
    if (!op.text) continue;
    const loose = op.limits.includes('font-encoding-unresolved');
    op.text.glyphs.forEach((g, gi) => {
      if (g.seq !== null && g.seq < map.glyphCount)
        glyphs[g.seq] = { op: op.id, glyph: gi, origin: g.origin, loose };
    });
  }
  let maxErr = 0;
  const chars = model.chars;
  const charMatch = align(
    chars.length,
    (i) => chars[i]!.glyphSeq,
    (j) => glyphs[j] !== undefined,
    glyphs.length,
    (i, j, prev) => {
      const g = glyphs[j];
      if (!g) return null;
      if (dist(chars[i]!.origin, g.origin) <= tol) return 'strong';
      if (g.loose && prev && prev.i === i - 1 && prev.j === j - 1) return 'loose';
      return null;
    },
    config.window,
  );
  const charOp = charMatch.map((j) => (j >= 0 ? glyphs[j]!.op : -1));
  const charGlyph = charMatch.map((j) => (j >= 0 ? glyphs[j]!.glyph : -1));
  charMatch.forEach((j, i) => {
    if (j < 0) return;
    const e = dist(chars[i]!.origin, glyphs[j]!.origin);
    if (e <= tol) maxErr = Math.max(maxErr, e);
  });

  // 도형
  const paints: (MapPaint | undefined)[] = new Array(map.paintCount);
  for (const op of map.ops) {
    op.paintSeq?.forEach((s, index) => {
      if (s < map.paintCount) paints[s] = { op, index };
    });
  }
  const modelPaints: ModelPaint[] = [
    ...model.paths.map((item, i) => ({ kind: 'path' as const, i, item })),
    ...model.images.map((item, i) => ({ kind: 'image' as const, i, item })),
    ...model.shades.map((item, i) => ({ kind: 'shade' as const, i, item })),
  ].sort((a, b) => a.item.paintSeq - b.item.paintSeq);
  const u = map.userToPage;
  const paintMatch = align(
    modelPaints.length,
    (i) => modelPaints[i]!.item.paintSeq,
    (j) => paints[j] !== undefined,
    paints.length,
    (i, j) => {
      const p = paints[j];
      if (!p) return null;
      return compatible(modelPaints[i]!, p, u);
    },
    config.window,
  );
  const pathOp = new Array<number>(model.paths.length).fill(-1);
  const imageOp = new Array<number>(model.images.length).fill(-1);
  const shadeOp = new Array<number>(model.shades.length).fill(-1);
  paintMatch.forEach((j, i) => {
    if (j < 0) return;
    const mp = modelPaints[i]!;
    const id = paints[j]!.op.id;
    if (mp.kind === 'path') pathOp[mp.i] = id;
    else if (mp.kind === 'image') imageOp[mp.i] = id;
    else shadeOp[mp.i] = id;
  });

  // 짝이 없는 번호를 가진 연산 표시
  const matchedGlyph = new Uint8Array(glyphs.length);
  for (const j of charMatch) if (j >= 0) matchedGlyph[j] = 1;
  const matchedPaint = new Uint8Array(paints.length);
  for (const j of paintMatch) if (j >= 0) matchedPaint[j] = 1;
  const mark = (op: SourceOp) => {
    if (!op.limits.includes('unmatched')) op.limits.push('unmatched');
  };
  for (const op of map.ops) {
    const g = op.text?.glyphs.some((x) => x.seq !== null && !matchedGlyph[x.seq]);
    const p = op.paintSeq?.some((s) => !matchedPaint[s]);
    if (g || p) mark(op);
  }

  const stats: LinkStats = {
    chars: chars.length,
    matchedChars: charMatch.filter((j) => j >= 0).length,
    paints: modelPaints.length,
    matchedPaints: paintMatch.filter((j) => j >= 0).length,
    maxOriginError: maxErr,
    glyphCountDelta: model.glyphCount - map.glyphCount,
    paintCountDelta: model.paintCount - map.paintCount,
  };
  return {
    pageIndex: map.pageIndex,
    charOp,
    charGlyph,
    pathOp,
    imageOp,
    shadeOp,
    stats,
    linkMs: now() - t0,
  };
}

/**
 * 모델 도형과 맵 연산의 호환. 행렬·경계로 확인되면 strong, 종류만 맞으면 loose(현재 delta 에서만 인정).
 */
function compatible(mp: ModelPaint, p: MapPaint, u: Matrix): 'strong' | 'loose' | null {
  const op = p.op;
  const toPage = concat(op.ctm, u);
  if (mp.kind === 'path') {
    const pathOp = mp.item.op;
    if (op.kind === 'path-paint' || op.kind === 'clip') {
      if (op.kind === 'clip' && pathOp !== 'clip') return null;
      return sameMatrix(mp.item.ctm, toPage) ? 'strong' : null;
    }
    // Form BBox 클립(행렬은 Form /Matrix 를 포함해 비교하지 않는다).
    if (op.kind === 'xobject') return pathOp === 'clip' ? 'loose' : null;
    return null;
  }
  if (mp.kind === 'image') {
    if (op.kind !== 'xobject' && op.kind !== 'inline-image') return null;
    const a = mp.item.bbox;
    const b = unitBox(toPage);
    const scale = Math.max(1, ...b.map(Math.abs));
    return a.every((v, i) => Math.abs(v - b[i]!) <= 1e-2 * scale) ? 'strong' : 'loose';
  }
  // 셰이드: sh, 셰이딩 패턴 칠하기·텍스트·마스크 이미지.
  if (
    op.kind === 'shading' ||
    op.kind === 'path-paint' ||
    op.kind === 'text-show' ||
    op.kind === 'xobject' ||
    op.kind === 'inline-image'
  ) {
    return op.kind === 'shading' ? 'strong' : 'loose';
  }
  return null;
}
