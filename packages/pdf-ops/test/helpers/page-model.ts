/**
 * 테스트 전용 최소 PageModel 생성기(core 의존 없음, 패키지에서 내보내지 않음).
 * `runPageContents`(항등 행렬) Device 콜백을 계약 3절 규칙으로 센다. 매칭 검증에 필요한 필드만 채운다
 * (quad·lines·blocks·색은 자리 채움).
 *
 * glyphSeq 정책
 * - first-arrival: 계약 3.1 core 판정(`first-arrival.ts`). gid −1 보조 글리프는 직전 글리프 글자에 붙인다.
 * - no-clip(채택하지 않은 core 안 A, 비교용): clipText·clipStrokeText 글리프는 세지 않는다. 직전 텍스트 콜백과
 *   포인터가 같고 그 콜백을 셌으면 세지 않는다.
 * paintSeq: 칠하기 콜백마다 1. beginMask~endMask 사이는 세지 않는다. beginTile 은 1(캐시됨)을 돌려준다.
 */
import * as mupdf from 'mupdf';
import { releaseBorrowedShade } from '../../src/mupdf-util.js';
import { FirstArrivalJudge, glyphKey, type TextCallbackKind } from './first-arrival.js';
import type {
  CharInfo,
  ImageInfo,
  Matrix,
  PageModel,
  PathInfo,
  Point,
  ShadeInfo,
} from '@pdf-editor/shared-types';

/**
 * first-arrival = 계약 3.1 판정(수정 6), first-arrival-v2 = 수정 2–5 의 1단계(비교·회귀 재현용),
 * no-clip = 채택하지 않은 core 안 A(비교용).
 */
export type HelperPolicy = 'first-arrival' | 'first-arrival-v2' | 'no-clip';

const apply = (m: Matrix, x: number, y: number): Point => [
  x * m[0] + y * m[2] + m[4],
  x * m[1] + y * m[3] + m[5],
];

function unitBox(m: Matrix): [number, number, number, number] {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function buildTestPageModel(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  policy: HelperPolicy = 'first-arrival',
): PageModel {
  const page = doc.loadPage(pageIndex);
  const chars: CharInfo[] = [];
  const paths: PathInfo[] = [];
  const images: ImageInfo[] = [];
  const shades: ShadeInfo[] = [];
  let glyphSeq = 0;
  let paintSeq = 0;
  let mask = 0;
  const held: mupdf.Text[] = [];
  const fontIds = new Map<number, number>();
  let lastPointer: number | null = null;
  let lastCounted = false;
  const judge = new FirstArrivalJudge({ step1FillStrokeOnly: policy === 'first-arrival-v2' });

  const pushChar = (
    kind: TextCallbackKind,
    font: mupdf.Font,
    trm: Matrix,
    ctm: Matrix,
    gid: number,
    unicode: number,
  ) => {
    let fontId = fontIds.get(font.pointer);
    if (fontId === undefined) {
      fontId = fontIds.size;
      fontIds.set(font.pointer, fontId);
    }
    const origin = apply(ctm, trm[4], trm[5]);
    chars.push({
      glyphSeq: glyphSeq++,
      text: String.fromCodePoint(unicode),
      gid,
      fontId,
      size: Math.hypot(trm[2], trm[3]) * Math.hypot(ctm[2], ctm[3]),
      origin,
      quad: [
        origin[0],
        origin[1],
        origin[0],
        origin[1],
        origin[0],
        origin[1],
        origin[0],
        origin[1],
      ],
      color: null,
      render:
        kind === 'ignore'
          ? 'invisible'
          : kind === 'stroke' || kind === 'clip-stroke'
            ? 'stroke'
            : 'fill',
      clip: kind === 'clip' || kind === 'clip-stroke',
      wmode: 0,
      line: -1,
    });
  };

  const text =
    (kind: TextCallbackKind) =>
    (t: mupdf.Text, ...rest: unknown[]) => {
      if (mask > 0) return;
      held.push(t);
      const ctm = rest.find((r) => Array.isArray(r) && r.length === 6) as Matrix;
      const glyphs: { font: mupdf.Font; trm: Matrix; gid: number; unicode: number }[] = [];
      t.walk({
        showGlyph: (font, trm, gid, unicode) =>
          void glyphs.push({ font, trm: trm as Matrix, gid, unicode }),
      });
      const isClip = kind === 'clip' || kind === 'clip-stroke';
      if (policy === 'no-clip') {
        const same = t.pointer === lastPointer;
        lastPointer = t.pointer;
        if (isClip) {
          lastCounted = false;
          return;
        }
        if (same && lastCounted) return;
        let last: CharInfo | undefined;
        for (const g of glyphs) {
          if (g.gid < 0) {
            if (last) last.text += String.fromCodePoint(g.unicode);
            continue;
          }
          pushChar(kind, g.font, g.trm, ctm, g.gid, g.unicode);
          last = chars.at(-1);
        }
        lastCounted = true;
        return;
      }
      // first-arrival: 계약 3.1 core 판정(0단계: gid −1 보조 글리프는 직전 글리프 글자에 붙인다).
      const real = glyphs.filter((g) => g.gid >= 0);
      const decisions = judge.judge(
        kind,
        t.pointer,
        real.map((g) => glyphKey(g.font.pointer, g.gid, g.trm, ctm)),
      );
      if (!decisions) return;
      let k = 0;
      let last: CharInfo | undefined;
      for (const g of glyphs) {
        if (g.gid < 0) {
          if (last) last.text += String.fromCodePoint(g.unicode);
          continue;
        }
        if (decisions[k++]) {
          pushChar(kind, g.font, g.trm, ctm, g.gid, g.unicode);
          last = chars.at(-1);
        } else last = undefined;
      }
    };

  const path =
    (op: PathInfo['op']) =>
    (_p: mupdf.Path, ...rest: unknown[]) => {
      if (mask > 0) return;
      const ctm = rest.find((r) => Array.isArray(r) && r.length === 6) as Matrix;
      paths.push({
        paintSeq: paintSeq++,
        op,
        evenOdd: false,
        bbox: [0, 0, 0, 0],
        ctm,
        color: null,
        alpha: 1,
        lineWidth: null,
        segments: null,
      });
    };
  const image = (op: ImageInfo['op']) => (img: mupdf.Image, ctm: Matrix) => {
    if (mask > 0) return;
    images.push({
      paintSeq: paintSeq++,
      op,
      bbox: unitBox(ctm),
      ctm,
      width: img.getWidth(),
      height: img.getHeight(),
      alpha: 1,
    });
  };

  const device = new mupdf.Device({
    fillText: text('fill'),
    strokeText: text('stroke'),
    clipText: text('clip'),
    clipStrokeText: text('clip-stroke'),
    ignoreText: text('ignore'),
    fillPath: path('fill'),
    strokePath: path('stroke'),
    clipPath: path('clip'),
    clipStrokePath: path('clip-stroke'),
    fillShade: (shade) => {
      // 빌린 Shade 래퍼: 종료자를 해제해야 GC 가 셰이드를 놓지 않는다(core extract.ts 와 같음).
      releaseBorrowedShade(shade);
      if (mask > 0) return;
      shades.push({ paintSeq: paintSeq++, bbox: [0, 0, 0, 0], alpha: 1 });
    },
    fillImage: image('image'),
    fillImageMask: image('image-mask'),
    clipImageMask: image('clip-image-mask'),
    beginMask: () => void mask++,
    endMask: () => void mask--,
    beginTile: () => 1,
  });
  const t0 = performance.now();
  page.runPageContents(device, mupdf.Matrix.identity);
  device.close();
  // 동기 루프에서는 FinalizationRegistry 정리가 돌지 않으므로 직접 해제한다(장치 표의 콜백 클로저·텍스트 참조).
  device.destroy();
  for (const t of held) t.destroy();
  const pdfPage = page as mupdf.PDFPage;
  return {
    pageIndex,
    bounds: page.getBounds() as PageModel['bounds'],
    userToPage: pdfPage.getTransform() as Matrix,
    rotation: 0,
    fonts: [],
    chars,
    lines: [],
    blocks: [],
    paths,
    images,
    shades,
    glyphCount: glyphSeq,
    paintCount: paintSeq,
    warnings: [],
    extractMs: performance.now() - t0,
  };
}
