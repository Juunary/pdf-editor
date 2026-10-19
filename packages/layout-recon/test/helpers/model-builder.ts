/**
 * 시험용 PageModel 생성기(MuPDF 없이). 글자 폭은 크기 × advance(기본 0.5)로 근사하고
 * 줄마다 블록 하나를 만든다. 공백은 실제 공백 글자로 넣는다.
 */
import type {
  CharInfo,
  FontInfo,
  ImageInfo,
  LineInfo,
  Matrix,
  PageModel,
  PathInfo,
  PathSegment,
  Point,
  RGB,
  Rect,
} from '@pdf-editor/shared-types';

export interface LineSpec {
  /** 첫 글자 왼쪽 x. */
  x: number;
  /** 기준선 y(페이지 공간, 아래로 증가). */
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: RGB | null;
  /** 글자 폭 = size × advance. */
  advance?: number;
  /** 같은 블록 번호를 주면 한 블록으로 묶는다. 없으면 줄마다 새 블록. */
  block?: number;
}

export interface PathSpec {
  op?: PathInfo['op'];
  segments: PathSegment[];
  lineWidth?: number;
  ctm?: Matrix;
  color?: RGB | null;
}

export interface ModelSpec {
  width?: number;
  height?: number;
  lines?: LineSpec[];
  paths?: PathSpec[];
  images?: Rect[];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** 사각형 경로 세그먼트(re 연산자와 같은 M L L L Z). */
export function rectSegments([x0, y0, x1, y1]: Rect): PathSegment[] {
  return [
    { type: 'M', p: [x0, y0] },
    { type: 'L', p: [x1, y0] },
    { type: 'L', p: [x1, y1] },
    { type: 'L', p: [x0, y1] },
    { type: 'Z' },
  ];
}

export function lineSegments(a: Point, b: Point): PathSegment[] {
  return [
    { type: 'M', p: a },
    { type: 'L', p: b },
  ];
}

/** 격자 표 괘선(가로 ys × 세로 xs, 각 선은 stroke 경로 하나). */
export function gridPaths(xs: number[], ys: number[], lineWidth = 0.5): PathSpec[] {
  const out: PathSpec[] = [];
  const x0 = xs[0]!;
  const x1 = xs.at(-1)!;
  const y0 = ys[0]!;
  const y1 = ys.at(-1)!;
  for (const y of ys)
    out.push({ op: 'stroke', segments: lineSegments([x0, y], [x1, y]), lineWidth });
  for (const x of xs)
    out.push({ op: 'stroke', segments: lineSegments([x, y0], [x, y1]), lineWidth });
  return out;
}

export function buildModel(spec: ModelSpec): PageModel {
  const width = spec.width ?? 612;
  const height = spec.height ?? 792;
  const fonts: FontInfo[] = [];
  const fontKey = new Map<string, number>();
  const chars: CharInfo[] = [];
  const lines: LineInfo[] = [];
  const blocks: { bbox: Rect; lines: number[] }[] = [];
  const blockIds = new Map<number, number>();
  for (const l of spec.lines ?? []) {
    const size = l.size ?? 10;
    const adv = size * (l.advance ?? 0.5);
    const key = `${l.bold ? 1 : 0}${l.italic ? 1 : 0}`;
    let fontId = fontKey.get(key);
    if (fontId === undefined) {
      fontId = fonts.length;
      fontKey.set(key, fontId);
      fonts.push({
        id: fontId,
        name: `Test${l.bold ? '-Bold' : ''}${l.italic ? '-Italic' : ''}`,
        bold: l.bold ?? false,
        italic: l.italic ?? false,
        serif: false,
        mono: false,
      });
    }
    const lineIndex = lines.length;
    const lineChars: number[] = [];
    let x = l.x;
    for (const ch of Array.from(l.text)) {
      const ci = chars.length;
      const quad = [
        x,
        l.y - size * 0.8,
        x + adv,
        l.y - size * 0.8,
        x,
        l.y + size * 0.2,
        x + adv,
        l.y + size * 0.2,
      ];
      chars.push({
        glyphSeq: ci,
        text: ch,
        gid: ch.codePointAt(0)!,
        fontId,
        size,
        origin: [x, l.y],
        quad: quad as CharInfo['quad'],
        color: l.color === undefined ? [0, 0, 0] : l.color,
        render: 'fill',
        clip: false,
        wmode: 0,
        line: lineIndex,
      });
      lineChars.push(ci);
      x += adv;
    }
    const bbox: Rect = [l.x, l.y - size * 0.8, x, l.y + size * 0.2];
    let block: number;
    if (l.block !== undefined && blockIds.has(l.block)) {
      block = blockIds.get(l.block)!;
      const b = blocks[block]!;
      b.lines.push(lineIndex);
      b.bbox = [
        Math.min(b.bbox[0], bbox[0]),
        Math.min(b.bbox[1], bbox[1]),
        Math.max(b.bbox[2], bbox[2]),
        Math.max(b.bbox[3], bbox[3]),
      ];
    } else {
      block = blocks.length;
      blocks.push({ bbox, lines: [lineIndex] });
      if (l.block !== undefined) blockIds.set(l.block, block);
    }
    lines.push({ bbox, wmode: 0, dir: [1, 0], block, chars: lineChars, spaceAfter: [] });
  }
  let paintSeq = 0;
  const paths: PathInfo[] = (spec.paths ?? []).map((p) => {
    const ctm = p.ctm ?? IDENTITY;
    const pts: Point[] = [];
    for (const s of p.segments) {
      if (s.type === 'M' || s.type === 'L') pts.push(s.p);
      else if (s.type === 'C') pts.push(s.p1, s.p2, s.p3);
    }
    const tp = pts.map(
      ([x, y]) => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]] as Point,
    );
    const lw = (p.op ?? 'stroke') === 'stroke' ? (p.lineWidth ?? 1) / 2 : 0;
    const xs = tp.map((q) => q[0]);
    const ys = tp.map((q) => q[1]);
    return {
      paintSeq: paintSeq++,
      op: p.op ?? 'stroke',
      evenOdd: false,
      bbox: [
        Math.min(...xs) - lw,
        Math.min(...ys) - lw,
        Math.max(...xs) + lw,
        Math.max(...ys) + lw,
      ],
      ctm,
      color:
        p.color === null
          ? null
          : { space: 'DeviceRGB', values: p.color ?? [0, 0, 0], rgb: p.color ?? [0, 0, 0] },
      alpha: 1,
      lineWidth: (p.op ?? 'stroke') === 'stroke' ? (p.lineWidth ?? 1) : null,
      segments: p.segments,
    };
  });
  const images: ImageInfo[] = (spec.images ?? []).map((r) => ({
    paintSeq: paintSeq++,
    op: 'image',
    bbox: r,
    ctm: [r[2] - r[0], 0, 0, r[3] - r[1], r[0], r[1]],
    width: 100,
    height: 100,
    alpha: 1,
  }));
  return {
    pageIndex: 0,
    bounds: [0, 0, width, height],
    userToPage: [1, 0, 0, -1, 0, height],
    rotation: 0,
    fonts,
    chars,
    lines,
    blocks,
    paths,
    images,
    shades: [],
    glyphCount: chars.length,
    paintCount: paintSeq,
    warnings: [],
    extractMs: 0,
  };
}
