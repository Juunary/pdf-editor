import * as mupdf from 'mupdf';
import type {
  BlockInfo,
  CharInfo,
  ExtractRequest,
  LineInfo,
  Matrix,
  PageModel,
  Quad,
  Rect,
} from '@pdf-editor/shared-types';
import { releaseBorrowedShade } from '@pdf-editor/pdf-ops';
import { ColorConverter } from './color.js';
import { DeviceCollector, type RawGlyph } from './extract-device.js';
import {
  glyphText,
  matchGlyphs,
  readStructuredText,
  unionQuads,
  type StextData,
} from './extract-stext.js';
import { pageRotation, transformPoint } from './page-geometry.js';

/** Extraction measurements (not put into PageModel; for measurement and tests). */
export interface ExtractStats {
  /** Number of glyphs counted (= chars.length). */
  glyphs: number;
  /** Number of structured-text characters (including annotation and widget text, and Tr 4–6 duplicates). */
  stextChars: number;
  /** Number of glyphs paired with a structured-text character. */
  matched: number;
  /** Number of glyphs with no match, whose quad was approximated and whose line was set to -1. */
  approximated: number;
  /** Number of structured-text characters left unpaired. */
  stextOnly: number;
  /** Of those, spaces (including spaces MuPDF synthesized for gaps). */
  stextOnlySpaces: number;
  /** Number of glyphs consumed by ET re-sends (Tr 4–7 clip callbacks) and not counted. */
  retransmitted: number;
  /** Number of glyphs first counted by clipText and clipStrokeText (Tr 7, pattern-color text, re-sends of a disabled /OC, ...). */
  clipCounted: number;
  /** Number of times color conversion failed and rgb was left null. */
  colorFailures: number;
  /** Number of entries left on the clip stack when the run ended. If not 0, a clip callback (the popClip pair) was missed. */
  clipDepth: number;
}

export interface ExtractResult {
  model: PageModel;
  stats: ExtractStats;
}

/** Heights above and below the character used for quad approximation (relative to font size). Used only when there is no structured-text value. */
const APPROX_ASCENT = 0.95;
const APPROX_DESCENT = 0.25;

/**
 * Builds the extraction model and measurements for one page. Annotations and widgets are excluded (`runPageContents`).
 * MuPDF warnings are intercepted only during the run and put into `warnings`; afterwards the log callback is released (`setLog(null)`).
 * mupdf.js 1.28.1 has no API to read the current logger, so the previous logger cannot be restored. In this repository `setLog` is used
 * only here, so releasing it is the same as restoring the default (MuPDF default output). If a logger is set elsewhere, this function must be wrapped.
 */
export function extractPageDetailed(page: mupdf.PDFPage, request: ExtractRequest): ExtractResult {
  const t0 = performance.now();
  const messages: string[] = [];
  mupdf.setLog((message: string) => {
    const text = message.trim();
    if (text) messages.push(text);
  });
  try {
    return build(page, request, messages, t0);
  } finally {
    mupdf.setLog(null);
  }
}

export function extractPageModel(page: mupdf.PDFPage, request: ExtractRequest): PageModel {
  return extractPageDetailed(page, request).model;
}

function build(
  page: mupdf.PDFPage,
  request: ExtractRequest,
  messages: string[],
  t0: number,
): ExtractResult {
  const bounds = page.getBounds() as Rect;
  const colors = new ColorConverter();
  const collector = new DeviceCollector(bounds, colors, request.includePathSegments === true);

  const device = new mupdf.Device({
    // The collector takes over the text wrapper (for comparing against the previous object) and releases it. If guard skips (after a failure, or inside a soft mask), release it here.
    fillText: (text, ctm, cs, color) => {
      if (!collector.guard(() => collector.fillText(text, ctm, cs, color))) text.destroy();
      cs.destroy();
    },
    strokeText: (text, stroke, ctm, cs, color) => {
      if (!collector.guard(() => collector.strokeText(text, ctm, cs, color))) text.destroy();
      stroke.destroy();
      cs.destroy();
    },
    ignoreText: (text, ctm) => {
      if (!collector.guard(() => collector.ignoreText(text, ctm))) text.destroy();
    },
    clipText: (text, ctm) => {
      if (!collector.guard(() => collector.clipText(text, ctm))) text.destroy();
    },
    clipStrokeText: (text, stroke, ctm) => {
      if (!collector.guard(() => collector.clipText(text, ctm))) text.destroy();
      stroke.destroy();
    },
    fillPath: (path, evenOdd, ctm, cs, color, alpha) => {
      collector.guard(() => collector.fillPath(path, evenOdd, ctm, cs, color, alpha));
      path.destroy();
      cs.destroy();
    },
    strokePath: (path, stroke, ctm, cs, color, alpha) => {
      collector.guard(() => collector.strokePath(path, stroke, ctm, cs, color, alpha));
      path.destroy();
      stroke.destroy();
      cs.destroy();
    },
    clipPath: (path, evenOdd, ctm) => {
      collector.guard(() => collector.clipPath(path, evenOdd, ctm));
      path.destroy();
    },
    clipStrokePath: (path, stroke, ctm) => {
      collector.guard(() => collector.clipStrokePath(path, stroke, ctm));
      path.destroy();
      stroke.destroy();
    },
    fillShade: (shade, ctm, alpha) => {
      collector.guard(() => collector.fillShade(shade, ctm, alpha));
      // Borrowed reference (if the finalizer releases it, the shade is freed; measured: "Unexpected mesh type ..."). Release with the shared pdf-ops tool.
      releaseBorrowedShade(shade);
    },
    fillImage: (image, ctm, alpha) => {
      collector.guard(() => collector.fillImage(image, ctm, alpha));
      image.destroy();
    },
    fillImageMask: (image, ctm, cs, _color, alpha) => {
      collector.guard(() => collector.fillImageMask(image, ctm, alpha));
      image.destroy();
      cs.destroy();
    },
    clipImageMask: (image, ctm) => {
      collector.guard(() => collector.clipImageMask(image, ctm));
      image.destroy();
    },
    popClip: () => collector.guard(() => collector.popClip()),
    beginMask: (_bbox, _luminosity, cs) => {
      collector.guard(() => collector.beginMask(), true);
      cs.destroy();
    },
    endMask: () => collector.guard(() => collector.endMask(), true),
    // Non-zero value: MuPDF does not execute the tiling pattern cell content (outside the page content order).
    beginTile: () => {
      collector.guard(() => collector.beginTile());
      return 1;
    },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
    collector.finish();
  }
  if (collector.error !== null) throw collector.error;

  let stext: StextData;
  try {
    stext = readStructuredText(page);
  } catch (e) {
    // Even if structured text fails (corrupt shading mesh, etc.), build the model from the information obtained from the Device.
    // All characters get an approximated quad and line -1.
    const reason = e instanceof Error ? e.message : String(e);
    messages.push(`구조화 텍스트 생성 실패: ${reason}`);
    stext = { chars: [], lines: [], blocks: [] };
  }
  const matches = matchGlyphs(collector.glyphs, stext);
  const { chars, lines, blocks, approximated } = assemble(collector.glyphs, matches, stext);

  const stats: ExtractStats = {
    glyphs: chars.length,
    stextChars: stext.chars.length,
    matched: chars.length - approximated.length,
    approximated: approximated.length,
    stextOnly: 0,
    stextOnlySpaces: 0,
    retransmitted: collector.retransmitted,
    clipCounted: collector.clipCounted,
    colorFailures: colors.failures,
    clipDepth: collector.clipDepth,
  };
  for (const ch of stext.chars) {
    if (ch.owner !== -1) continue;
    stats.stextOnly++;
    if (ch.rune === 0x20 || ch.rune === 0xa0) stats.stextOnlySpaces++;
  }

  const warnings = messages.map((m) => `MuPDF: ${m}`);
  if (approximated.length > 0) {
    const sample = approximated.slice(0, 5).join(', ');
    warnings.push(
      `구조화 텍스트에 없는 글자 ${approximated.length}개: quad 근사, line -1 (glyphSeq ${sample}${approximated.length > 5 ? ' …' : ''})`,
    );
  }
  if (colors.failures > 0) {
    warnings.push(`sRGB 변환 실패 ${colors.failures}회: rgb null`);
  }

  const model: PageModel = {
    pageIndex: request.pageIndex,
    bounds,
    userToPage: page.getTransform() as Matrix,
    rotation: pageRotation(page),
    fonts: collector.fonts,
    chars,
    lines,
    blocks,
    paths: collector.paths,
    images: collector.images,
    shades: collector.shades,
    glyphCount: collector.glyphs.length,
    paintCount: collector.paintSeq,
    warnings,
    extractMs: performance.now() - t0,
  };
  return { model, stats };
}

/**
 * Joins Device glyphs and structured text to build chars, lines and blocks.
 * Lines and blocks keep only characters paired with a glyph (excluding Tr 4–6 duplicate lines, synthetic spaces and annotation text),
 * and empty lines and blocks are dropped.
 */
function assemble(
  glyphs: readonly RawGlyph[],
  matches: ReadonlyArray<ReturnType<typeof matchGlyphs>[number]>,
  stext: StextData,
): { chars: CharInfo[]; lines: LineInfo[]; blocks: BlockInfo[]; approximated: number[] } {
  // Re-index lines and blocks: keep only lines that have a paired character.
  const lineMap = new Map<number, number>();
  const blockMap = new Map<number, number>();
  const lines: LineInfo[] = [];
  const blocks: BlockInfo[] = [];
  for (let l = 0; l < stext.lines.length; l++) {
    const line = stext.lines[l]!;
    const kept: number[] = [];
    // A structured-text space with no glyph match (synthesized by MuPDF for character spacing) puts the previous character's position into spaceAfter
    // only when it lies between characters (spaces at the start or end of a line are not needed in the reading text).
    const spaceAfter: number[] = [];
    let pendingSpace = false;
    for (const ch of line.chars) {
      if (ch.owner === -1) {
        if (ch.rune === 0x20 || ch.rune === 0xa0) pendingSpace = kept.length > 0;
        continue;
      }
      // For the trailing part of a ligature (a character with the same owner but not primary), add it only once per glyph.
      if (matches[ch.owner] !== ch) continue;
      if (pendingSpace) spaceAfter.push(kept.length - 1);
      pendingSpace = false;
      kept.push(ch.owner);
    }
    if (kept.length === 0) continue;
    let block = blockMap.get(line.block);
    if (block === undefined) {
      block = blocks.length;
      blockMap.set(line.block, block);
      blocks.push({ bbox: stext.blocks[line.block]!.bbox, lines: [] });
    }
    lineMap.set(l, lines.length);
    blocks[block]!.lines.push(lines.length);
    lines.push({
      bbox: line.bbox,
      wmode: line.wmode,
      dir: line.dir,
      block,
      chars: kept,
      spaceAfter,
    });
  }

  const approximated: number[] = [];
  const chars: CharInfo[] = glyphs.map((g, glyphSeq) => {
    const match = matches[glyphSeq] ?? null;
    if (!match) approximated.push(glyphSeq);
    return {
      glyphSeq,
      text: glyphText(g.unicode, g.extra),
      gid: g.gid,
      fontId: g.fontId,
      size: g.size,
      origin: [g.m[4], g.m[5]],
      quad: match ? unionQuads([match, ...match.parts]) : approximateQuad(g),
      color: g.noColor ? null : match ? match.rgb : g.rgb,
      render: g.render,
      clip: g.clip,
      wmode: g.wmode,
      line: match ? (lineMap.get(match.line) ?? -1) : -1,
    };
  });
  return { chars, lines, blocks, approximated };
}

/** Approximates the quad of a character absent from the structured text from the glyph matrix and advance (order ul, ur, ll, lr). */
function approximateQuad(g: RawGlyph): Quad {
  const advance = Math.abs(g.advance);
  const [x0, x1, top, bottom] =
    g.wmode === 1 ? [-0.5, 0.5, 0, -advance] : [0, advance, APPROX_ASCENT, -APPROX_DESCENT];
  const ul = transformPoint(g.m, x0, top);
  const ur = transformPoint(g.m, x1, top);
  const ll = transformPoint(g.m, x0, bottom);
  const lr = transformPoint(g.m, x1, bottom);
  return [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]];
}
