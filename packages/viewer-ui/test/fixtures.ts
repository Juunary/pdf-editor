/**
 * Synthetic PageModel for tests. Shared by unit tests and the Playwright harness (apps/extension/e2e).
 * Stacks lines on a grid with character width `charWidth` and height `charHeight` (page-space pt, origin at top left).
 */
import type {
  CharInfo,
  LineInfo,
  PageLinkage,
  PageModel,
  Quad,
  SourceMap,
  SourceOp,
} from '@pdf-editor/shared-types';

export interface FixtureLine {
  text: string;
  /** Left x of the line (default 20). */
  x?: number;
  /** Top y of the line (default 20 + line number × line spacing). */
  y?: number;
  /** The same number means the same block. By default, each line is a different block. */
  block?: number;
  /** Synthetic whitespace positions (`LineInfo.spaceAfter`): k = after the k-th character of text. None by default. */
  spaceAfter?: number[];
}

export interface FixtureOptions {
  charWidth?: number;
  charHeight?: number;
  lineGap?: number;
  /** Characters not in the structured text (line = -1). Laid out on a single line. */
  orphanText?: string;
}

export function rectQuad(x: number, y: number, w: number, h: number): Quad {
  return [x, y, x + w, y, x, y + h, x + w, y + h];
}

export function makePageModel(
  input: (FixtureLine | string)[],
  options: FixtureOptions = {},
): PageModel {
  const { charWidth = 10, charHeight = 14, lineGap = 6, orphanText } = options;
  const chars: CharInfo[] = [];
  const lines: LineInfo[] = [];
  const blocks = new Map<number, number[]>();

  const place = (text: string, x: number, y: number, line: number): number[] => {
    const indices: number[] = [];
    [...text].forEach((ch, i) => {
      const left = x + i * charWidth;
      indices.push(chars.length);
      chars.push({
        glyphSeq: chars.length,
        text: ch,
        gid: ch.codePointAt(0) ?? 0,
        fontId: 0,
        size: 12,
        origin: [left, y + charHeight * 0.8],
        quad: rectQuad(left, y, charWidth, charHeight),
        color: [0, 0, 0],
        render: 'fill',
        clip: false,
        wmode: 0,
        line,
      });
    });
    return indices;
  };

  input.forEach((entry, i) => {
    const spec: FixtureLine = typeof entry === 'string' ? { text: entry } : entry;
    const x = spec.x ?? 20;
    const y = spec.y ?? 20 + i * (charHeight + lineGap);
    const blockKey = spec.block ?? 1000 + i;
    const indices = place(spec.text, x, y, i);
    const last = chars[indices[indices.length - 1]!];
    lines.push({
      bbox: [x, y, last ? last.quad[2] : x, y + charHeight],
      wmode: 0,
      dir: [1, 0],
      block: 0, // block numbers are assigned below.
      chars: indices,
      spaceAfter: spec.spaceAfter ?? [],
    });
    const group = blocks.get(blockKey) ?? [];
    group.push(i);
    blocks.set(blockKey, group);
  });

  const blockList = [...blocks.values()];
  blockList.forEach((lineIndices, blockIndex) => {
    for (const li of lineIndices) lines[li]!.block = blockIndex;
  });

  if (orphanText) {
    place(orphanText, 20, 20 + input.length * (charHeight + lineGap), -1);
  }

  return {
    pageIndex: 0,
    bounds: [0, 0, 600, 800],
    userToPage: [1, 0, 0, -1, 0, 800],
    rotation: 0,
    fonts: [{ id: 0, name: 'Fixture', bold: false, italic: false, serif: false, mono: false }],
    chars,
    lines,
    blocks: blockList.map((lineIndices) => ({
      bbox: [0, 0, 600, 800],
      lines: lineIndices,
    })),
    paths: [],
    images: [],
    shades: [],
    glyphCount: chars.length,
    paintCount: 0,
    warnings: [],
    extractMs: 0,
  };
}

/** PageLinkage built from per-character op numbers (-1 = match failure). */
export function makeLinkage(model: PageModel, charOp: number[]): PageLinkage {
  const matched = charOp.filter((o) => o >= 0).length;
  return {
    pageIndex: model.pageIndex,
    charOp,
    charGlyph: charOp.map((o, i) => (o >= 0 ? i : -1)),
    pathOp: [],
    imageOp: [],
    shadeOp: [],
    stats: {
      chars: model.chars.length,
      matchedChars: matched,
      paints: 0,
      matchedPaints: 0,
      maxOriginError: 0.25,
      glyphCountDelta: 0,
      paintCountDelta: 0,
    },
    linkMs: 1,
  };
}

export function makeTextOp(id: number, overrides: Partial<SourceOp> = {}): SourceOp {
  return {
    id,
    op: 'Tj',
    kind: 'text-show',
    stream: { objectNumber: 8, contentsIndex: 0 },
    range: [100 + id * 10, 110 + id * 10],
    formPath: [],
    ctm: [1, 0, 0, 1, 0, 0],
    clipDepth: 0,
    mcids: [],
    optionalContent: false,
    limits: [],
    ...overrides,
  };
}

export function makeSourceMap(model: PageModel, ops: SourceOp[]): SourceMap {
  return {
    pageIndex: model.pageIndex,
    userToPage: model.userToPage,
    streams: [{ objectNumber: 8, contentsIndex: 0, decodedLength: 4000, filters: [] }],
    ops,
    glyphCount: model.glyphCount,
    paintCount: 0,
    errors: [],
    buildMs: 1,
  };
}
