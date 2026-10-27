/**
 * PageModel ↔ SourceMap matching (docs/m1-contract.md section 3).
 *
 * - Characters: pairs those with the same glyphSeq and checks that the origin error is within tolerance. On a mismatch, the number difference (delta) is
 *   searched again by origin within a window, and resynchronization happens only if the following character also fits with the same delta.
 * - Shapes: pairs those with the same paintSeq and checks by kind compatibility, matrix (path) and bounds (image). Resynchronization is the same as for characters.
 *   For `outside-page-content` operations (owned by directly executed pattern cells), cell painting is accepted regardless of kind only at the current delta.
 * - Glyphs of fonts with incomplete width information (font-encoding-unresolved) may have a shifted origin, so if the number
 *   continues from the previous character they are accepted without an origin check (not used as a resynchronization criterion).
 * - Failed characters/shapes get -1. Operations with an unpaired number get an `unmatched` limit (map is modified).
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
  /** Resynchronization search window (number difference). */
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
  /** Which paintSeq of the same operation this is. */
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
 * Order alignment: pairs the model[i] number seq(i) with the map number seq(i)+delta.
 * - If the map side has an ownerless number (hole: pattern cell content, etc.), that item is not matched and delta is kept.
 * - If it does not match an owned number, delta is searched again within the window. A candidate delta is adopted only if up to 2 following items
 *   (non-holes) fit strongly with the same delta.
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

  // Characters
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

  // Shapes
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

  // Mark operations with an unpaired number
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
 * Compatibility of a model shape and a map operation. Strong if confirmed by matrix/bounds, loose if only the kind matches (accepted only at the current delta).
 */
function compatible(mp: ModelPaint, p: MapPaint, u: Matrix): 'strong' | 'loose' | null {
  const own = compatibleOwn(mp, p, u);
  if (own) return own;
  // Painting of a directly executed tiling pattern cell is owned by that pattern-painting operation (contract section 3). Kind and matrix are cell-relative,
  // so it is accepted only at the current delta.
  return p.op.limits.includes('outside-page-content') ? 'loose' : null;
}

function compatibleOwn(mp: ModelPaint, p: MapPaint, u: Matrix): 'strong' | 'loose' | null {
  const op = p.op;
  const toPage = concat(op.ctm, u);
  if (mp.kind === 'path') {
    const pathOp = mp.item.op;
    if (op.kind === 'path-paint' || op.kind === 'clip') {
      if (op.kind === 'clip' && pathOp !== 'clip') return null;
      return sameMatrix(mp.item.ctm, toPage) ? 'strong' : null;
    }
    // Form BBox clip (the matrix is not compared, as it includes the Form /Matrix).
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
  // Shade: sh, shading pattern painting, text and mask images.
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
