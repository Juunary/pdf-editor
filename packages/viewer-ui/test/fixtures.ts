/**
 * 테스트용 합성 PageModel. 단위 테스트와 Playwright 하니스(apps/extension/e2e)가 함께 쓴다.
 * 글자 폭 `charWidth`, 높이 `charHeight` 의 격자에 줄을 쌓는다(페이지 공간 pt, 원점 좌상단).
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
  /** 줄 왼쪽 x(기본 20). */
  x?: number;
  /** 줄 위쪽 y(기본 20 + 줄 번호 × 줄 간격). */
  y?: number;
  /** 같은 번호면 같은 블록. 기본은 줄마다 다른 블록. */
  block?: number;
}

export interface FixtureOptions {
  charWidth?: number;
  charHeight?: number;
  lineGap?: number;
  /** 구조화 텍스트에 없는(line = -1) 글자들. 줄 하나로 배치한다. */
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
      block: 0, // 아래에서 블록 번호를 매긴다.
      chars: indices,
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

/** 글자별 연산 번호(-1 = 매칭 실패)로 만든 PageLinkage. */
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
