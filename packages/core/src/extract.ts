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

/** 추출 계측값(PageModel 에는 넣지 않는다. 측정·테스트용). */
export interface ExtractStats {
  /** 센 글리프 수(= chars.length). */
  glyphs: number;
  /** 구조화 텍스트 글자 수(주석·위젯 텍스트, Tr 4–6 중복 포함). */
  stextChars: number;
  /** 구조화 텍스트 글자와 짝이 된 글리프 수. */
  matched: number;
  /** 짝이 없어 quad 를 근사하고 line 을 -1 로 둔 글리프 수. */
  approximated: number;
  /** 짝이 되지 못한 구조화 텍스트 글자 수. */
  stextOnly: number;
  /** 그중 공백(MuPDF 가 간격으로 합성한 공백 포함). */
  stextOnlySpaces: number;
  /** ET 재전송(Tr 4–7 클립 콜백)으로 소비해 세지 않은 글리프 수. */
  retransmitted: number;
  /** clipText·clipStrokeText 가 처음 센 글리프 수(Tr 7, 패턴 색 텍스트, 꺼진 /OC 의 재전송 …). */
  clipCounted: number;
  /** 색 변환에 실패해 rgb 를 null 로 둔 횟수. */
  colorFailures: number;
  /** 실행이 끝났을 때 클립 스택에 남은 항목 수. 0 이 아니면 클립 콜백(popClip 짝)을 놓친 것이다. */
  clipDepth: number;
}

export interface ExtractResult {
  model: PageModel;
  stats: ExtractStats;
}

/** quad 근사에 쓰는 글자 위·아래 높이(글자 크기 대비). 구조화 텍스트 값이 없을 때만 쓴다. */
const APPROX_ASCENT = 0.95;
const APPROX_DESCENT = 0.25;

/**
 * 페이지 하나의 추출 모델과 계측값을 만든다. 주석·위젯은 제외한다(`runPageContents`).
 * MuPDF 경고는 실행 중에만 가로채 `warnings` 에 담고, 끝나면 로그 콜백을 해제한다.
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
    fillText: (text, ctm, cs, color) => {
      collector.guard(() => collector.fillText(text, ctm, cs, color));
      cs.destroy();
    },
    strokeText: (text, stroke, ctm, cs, color) => {
      collector.guard(() => collector.strokeText(text, ctm, cs, color));
      stroke.destroy();
      cs.destroy();
    },
    ignoreText: (text, ctm) => collector.guard(() => collector.ignoreText(text, ctm)),
    clipText: (text, ctm) => collector.guard(() => collector.clipText(text, ctm)),
    clipStrokeText: (text, stroke, ctm) => {
      collector.guard(() => collector.clipText(text, ctm));
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
      // 빌린 참조(종료자가 놓으면 셰이드가 해제됨, 실측: "Unexpected mesh type …"). pdf-ops 공용 도구로 해제.
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
    // 0 이 아닌 값: 타일링 패턴 셀 내용을 MuPDF 가 실행하지 않는다(쪽 콘텐츠 순서 밖).
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
    // 구조화 텍스트가 실패해도(손상된 셰이딩 메시 등) Device 에서 얻은 정보로 모델을 만든다.
    // 모든 글자는 quad 근사·line -1 이 된다.
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
 * Device 글리프와 구조화 텍스트를 결합해 chars·lines·blocks 를 만든다.
 * 줄·블록에는 글리프와 짝이 된 글자만 남기고(Tr 4–6 중복 줄·합성 공백·주석 텍스트 제외),
 * 비는 줄·블록은 뺀다.
 */
function assemble(
  glyphs: readonly RawGlyph[],
  matches: ReadonlyArray<ReturnType<typeof matchGlyphs>[number]>,
  stext: StextData,
): { chars: CharInfo[]; lines: LineInfo[]; blocks: BlockInfo[]; approximated: number[] } {
  // 줄·블록 인덱스 재배치: 짝이 된 글자가 있는 줄만 남긴다.
  const lineMap = new Map<number, number>();
  const blockMap = new Map<number, number>();
  const lines: LineInfo[] = [];
  const blocks: BlockInfo[] = [];
  for (let l = 0; l < stext.lines.length; l++) {
    const line = stext.lines[l]!;
    const kept: number[] = [];
    // 글리프와 짝이 없는 구조화 텍스트 공백(MuPDF 가 글자 간격으로 합성)은 앞뒤 글자 사이에 있을 때만
    // 앞 글자 위치를 spaceAfter 에 담는다(줄 처음·끝의 공백은 읽기 텍스트에 필요 없다).
    const spaceAfter: number[] = [];
    let pendingSpace = false;
    for (const ch of line.chars) {
      if (ch.owner === -1) {
        if (ch.rune === 0x20 || ch.rune === 0xa0) pendingSpace = kept.length > 0;
        continue;
      }
      // 합자의 뒷부분(owner 만 같고 primary 가 아닌 글자)은 글리프당 한 번만 넣는다.
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

/** 구조화 텍스트에 없는 글자의 quad 를 글리프 행렬·advance 로 근사한다(순서 ul, ur, ll, lr). */
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
