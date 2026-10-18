/**
 * 테스트 전용 최소 PageModel 생성기(core 의존 없음, 패키지에서 내보내지 않음).
 * `runPageContents`(항등 행렬) Device 콜백을 계약 3절 규칙으로 센다. 매칭 검증에 필요한 필드만 채운다
 * (quad·lines·blocks·색은 자리 채움).
 *
 * glyphSeq 정책
 * - first-arrival(pdf-ops 안 A의 core 쪽 판정):
 *   1) 직전 텍스트 콜백과 포인터가 같은 텍스트 콜백은 세지 않는다(Tr 2·6, 패턴 색 fill→stroke).
 *   2) clipText·clipStrokeText·ignoreText 글리프 중 (폰트 포인터, gid, trm 6값)이 집합 K 에 있으면
 *      ET 재전송으로 보고 세지 않는다. K 에는 fillText·strokeText 로 센 글리프만 넣는다.
 *      재전송을 1개 이상 찾은 콜백 뒤 K 를 비운다.
 *   3) gid -1 보조 글리프(ToUnicode 1:N)는 세지 않는다.
 * - no-clip(core 안 A): clipText·clipStrokeText 글리프는 세지 않는다. 직전 텍스트 콜백과 포인터가 같고
 *   그 콜백을 셌으면 세지 않는다.
 * paintSeq: 칠하기 콜백마다 1. beginMask~endMask 사이는 세지 않는다. beginTile 은 1(캐시됨)을 돌려준다.
 */
import * as mupdf from 'mupdf';
import type {
  CharInfo,
  ImageInfo,
  Matrix,
  PageModel,
  PathInfo,
  Point,
  ShadeInfo,
} from '@pdf-editor/shared-types';

export type HelperPolicy = 'first-arrival' | 'no-clip';

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
  let known = new Set<string>();

  const text =
    (kind: 'fill' | 'stroke' | 'clip' | 'clipStroke' | 'ignore') =>
    (t: mupdf.Text, ...rest: unknown[]) => {
      if (mask > 0) return;
      held.push(t);
      const ctm = rest.find((r) => Array.isArray(r) && r.length === 6) as Matrix;
      const samePointer = t.pointer === lastPointer;
      lastPointer = t.pointer;
      const isClip = kind === 'clip' || kind === 'clipStroke';
      let counted = false;
      let resend = false;
      if (policy === 'no-clip') {
        if (isClip) {
          lastCounted = false;
          return;
        }
        if (samePointer && lastCounted) return;
      } else if (samePointer) return;
      t.walk({
        showGlyph: (font, trm, gid, unicode) => {
          if (gid < 0) {
            const last = chars.at(-1);
            if (last && counted) last.text += String.fromCodePoint(unicode);
            return;
          }
          const key = `${font.pointer}:${gid}:${trm.join(',')}`;
          if (policy === 'first-arrival' && (isClip || kind === 'ignore') && known.has(key)) {
            resend = true;
            return;
          }
          // ET 재전송은 Tr 4–6 의 fill·stroke 표시 글리프만 다시 보낸다. 그래서 K 에는 fill·stroke 글리프만 넣는다.
          if (kind === 'fill' || kind === 'stroke') known.add(key);
          let fontId = fontIds.get(font.pointer);
          if (fontId === undefined) {
            fontId = fontIds.size;
            fontIds.set(font.pointer, fontId);
          }
          const origin = apply(ctm, trm[4], trm[5]);
          const size = Math.hypot(trm[2], trm[3]) * Math.hypot(ctm[2], ctm[3]);
          chars.push({
            glyphSeq: glyphSeq++,
            text: String.fromCodePoint(unicode),
            gid,
            fontId,
            size,
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
                : kind === 'stroke' || kind === 'clipStroke'
                  ? 'stroke'
                  : 'fill',
            clip: isClip,
            wmode: 0,
            line: -1,
          });
          counted = true;
        },
      });
      if (resend) known = new Set();
      lastCounted = counted;
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
    clipStrokeText: text('clipStroke'),
    ignoreText: text('ignore'),
    fillPath: path('fill'),
    strokePath: path('stroke'),
    clipPath: path('clip'),
    clipStrokePath: path('clip-stroke'),
    fillShade: () => {
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
