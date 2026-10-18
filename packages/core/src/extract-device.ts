/**
 * `runPageContents`(항등 행렬)의 Device 콜백을 모아 글리프·도형·이미지·셰이드를 센다.
 * 순서 번호 규칙(docs/m1-contract.md 3절 + docs/m1-core.md 2절):
 * - glyphSeq: fillText·strokeText·ignoreText 의 글리프. 같은 텍스트 객체(포인터 동일)를 연속으로 받은
 *   fill→stroke(Tr 2·6)는 한 번으로 센다. clipText·clipStrokeText 는 `ClipTextPolicy` 를 따른다.
 * - paintSeq: 텍스트 외 그리기 콜백마다 1.
 * - 소프트 마스크 그룹(beginMask…endMask) 안의 콜백은 세지 않는다. 타일링 패턴의 셀 내용은 `beginTile`
 *   이 0 이 아닌 값을 돌려주어 MuPDF 가 실행하지 않게 한다. 둘 다 쪽 콘텐츠 스트림 실행 순서 밖이다.
 */
import * as mupdf from 'mupdf';
import type {
  FontInfo,
  ImageInfo,
  Matrix,
  PathInfo,
  PathSegment,
  Point,
  RGB,
  Rect,
  ShadeInfo,
  TextRender,
} from '@pdf-editor/shared-types';
import type { ColorConverter } from './color.js';
import { intersectRect, transformPoint, transformRect } from './page-geometry.js';

/** Device 가 준 글리프 하나(구조화 텍스트와 결합하기 전). */
export interface RawGlyph {
  gid: number;
  unicode: number;
  /**
   * 같은 글리프에 딸린 추가 유니코드. ToUnicode 가 글리프 하나를 여러 글자("Th", "fi", 점선 …)로
   * 대응시키면 MuPDF 는 글리프를 gid 로 한 번 보내고, 나머지 글자를 gid -1(폭 0) 항목으로 잇는다.
   * 그 항목은 글리프가 아니므로 세지 않고 여기에 모은다.
   */
  extra: number[];
  fontId: number;
  /** 글리프 공간(em, y 위) → 페이지 공간. e·f 가 기준선 원점. */
  m: Matrix;
  /** 페이지 공간 글자 크기(pt). */
  size: number;
  wmode: 0 | 1;
  render: TextRender;
  /** Tr 4–6 으로 클립에도 쓰인 글리프(clipText 가 같은 글리프를 다시 보낸 것을 찾아 표시). */
  clip: boolean;
  /** 이 글리프를 그린 색(invisible 이면 null). */
  rgb: RGB | null;
  /** 폰트 advance(em). quad 근사에 쓴다. */
  advance: number;
}

interface PrevText {
  ptr: unknown;
  text: mupdf.Text;
  kind: 'fill' | 'stroke' | 'fill-stroke' | 'invisible';
  first: number;
  end: number;
}

/** 클립 텍스트 글리프와 이미 센 글리프의 원점이 같다고 볼 오차(pt). */
const CLIP_MATCH_EPS = 0.05;

/**
 * clipText·clipStrokeText 글리프의 처리.
 * - ignore(수정안 A): 세지 않는다. 이미 센 글리프에 clip 표시만 한다.
 * - count-new(수정안 B'): 직전 텍스트 구간(마지막 비텍스트 콜백 이후)에서 이미 센 글리프와
 *   (폰트, gid, 원점)이 같으면 중복(Tr 4–6)으로 보고 clip 표시만, 아니면 새 글리프로 센다(Tr 7,
 *   패턴·셰이딩으로 칠한 텍스트).
 */
export type ClipTextPolicy = 'ignore' | 'count-new';

const unitRect: Rect = [0, 0, 1, 1];

export class DeviceCollector {
  readonly glyphs: RawGlyph[] = [];
  readonly fonts: FontInfo[] = [];
  readonly paths: PathInfo[] = [];
  readonly images: ImageInfo[] = [];
  readonly shades: ShadeInfo[] = [];
  paintSeq = 0;
  /** clipText 에만 있어 세지 않은 글리프 수. */
  clipOnlyGlyphs = 0;
  /** 콜백 안에서 난 첫 예외. WASM 프레임을 거쳐 던지지 않도록 모아 두었다가 실행 뒤에 던진다. */
  error: unknown = null;

  #fontIds = new Map<unknown, number>();
  #clipStack: Rect[];
  #prev: PrevText | null = null;
  #clipScan = 0;
  /** 마지막 비텍스트 콜백 시점의 글리프 수. count-new 에서 중복 후보 구간의 시작이다. */
  #windowStart = 0;
  #maskDepth = 0;

  constructor(
    pageBounds: Rect,
    private readonly colors: ColorConverter,
    private readonly includeSegments: boolean,
    private readonly clipPolicy: ClipTextPolicy,
  ) {
    this.#clipStack = [pageBounds];
  }

  /**
   * 콜백 본문을 실행한다. 이미 실패했거나 소프트 마스크 그룹 안이면 건너뛴다
   * (`structural` 은 마스크 경계 콜백용으로 마스크 안에서도 실행).
   */
  guard(body: () => void, structural = false): void {
    if (this.error !== null) return;
    if (this.#maskDepth > 0 && !structural) return;
    try {
      body();
    } catch (e) {
      this.error = e;
    }
  }

  /** 실행이 끝났을 때(성공·실패 모두) 잡고 있는 래퍼를 놓는다. */
  finish(): void {
    this.#releasePrev();
  }

  // --- 텍스트 -------------------------------------------------------------------------

  fillText(text: mupdf.Text, ctm: Matrix, cs: mupdf.ColorSpace, color: number[]): void {
    this.#show('fill', text, ctm, cs, color);
  }

  strokeText(text: mupdf.Text, ctm: Matrix, cs: mupdf.ColorSpace, color: number[]): void {
    this.#show('stroke', text, ctm, cs, color);
  }

  ignoreText(text: mupdf.Text, ctm: Matrix): void {
    this.#show('invisible', text, ctm, null, null);
  }

  /** clipText·clipStrokeText. 처리는 `ClipTextPolicy` 를 따른다. */
  clipText(text: mupdf.Text, ctm: Matrix): void {
    this.#releasePrev();
    let cursor = Math.max(this.#clipScan, this.#windowStart);
    let pushed: RawGlyph | null = null;
    try {
      text.walk({
        showGlyph: (font, trm, gid, unicode, wmode) => {
          if (gid < 0) {
            // 앞 글리프의 추가 유니코드. 새로 센 글리프에만 붙인다(이미 센 글리프는 fill/stroke 에서 받았다).
            pushed?.extra.push(unicode);
            return;
          }
          pushed = null;
          const known = this.#fontIds.get(font.pointer);
          const m = mupdf.Matrix.concat(trm, ctm) as Matrix;
          for (let i = cursor; known !== undefined && i < this.glyphs.length; i++) {
            const g = this.glyphs[i]!;
            if (
              !g.clip &&
              g.gid === gid &&
              g.fontId === known &&
              Math.abs(g.m[4] - m[4]) <= CLIP_MATCH_EPS &&
              Math.abs(g.m[5] - m[5]) <= CLIP_MATCH_EPS
            ) {
              g.clip = true;
              cursor = i + 1;
              return;
            }
          }
          this.clipOnlyGlyphs++;
          if (this.clipPolicy === 'count-new') {
            pushed = {
              gid,
              unicode,
              extra: [],
              fontId: this.#fontId(font),
              m,
              size: Math.hypot(m[2], m[3]),
              wmode: wmode === 1 ? 1 : 0,
              render: 'invisible',
              clip: true,
              rgb: null,
              advance: font.advanceGlyph(gid, wmode),
            };
            this.glyphs.push(pushed);
          }
        },
      });
    } finally {
      text.destroy();
    }
    this.#clipScan = this.glyphs.length;
    this.pushClip(this.top());
  }

  #show(
    kind: 'fill' | 'stroke' | 'invisible',
    text: mupdf.Text,
    ctm: Matrix,
    cs: mupdf.ColorSpace | null,
    color: number[] | null,
  ): void {
    const rgbOf = () => (cs && color ? this.colors.paint(cs, color).rgb : null);
    const prev = this.#prev;
    if (prev && prev.ptr === text.pointer) {
      // 같은 텍스트 객체를 연속으로 받은 fill↔stroke: 한 번의 표시(Tr 2·6).
      text.destroy();
      if (
        (prev.kind === 'fill' && kind === 'stroke') ||
        (prev.kind === 'stroke' && kind === 'fill')
      ) {
        const fillRgb = kind === 'fill' ? rgbOf() : null;
        for (let i = prev.first; i < prev.end; i++) {
          const g = this.glyphs[i]!;
          g.render = 'fill-stroke';
          if (kind === 'fill') g.rgb = fillRgb;
        }
        prev.kind = 'fill-stroke';
      }
      return;
    }
    this.#releasePrev();
    const rgb = kind === 'invisible' ? null : rgbOf();
    const first = this.glyphs.length;
    try {
      text.walk({
        showGlyph: (font, trm, gid, unicode, wmode) => {
          if (gid < 0) {
            // 앞 글리프의 추가 유니코드(ToUnicode 가 여러 글자인 글리프). 글리프가 아니므로 세지 않는다.
            if (this.glyphs.length > first)
              this.glyphs[this.glyphs.length - 1]!.extra.push(unicode);
            return;
          }
          const fontId = this.#fontId(font);
          const m = mupdf.Matrix.concat(trm, ctm) as Matrix;
          this.glyphs.push({
            gid,
            unicode,
            extra: [],
            fontId,
            m,
            size: Math.hypot(m[2], m[3]),
            wmode: wmode === 1 ? 1 : 0,
            render: kind,
            clip: false,
            rgb,
            advance: font.advanceGlyph(gid, wmode),
          });
        },
      });
    } catch (e) {
      text.destroy();
      throw e;
    }
    this.#prev = { ptr: text.pointer, text, kind, first, end: this.glyphs.length };
  }

  #fontId(font: mupdf.Font): number {
    const known = this.#fontIds.get(font.pointer);
    if (known !== undefined) return known;
    const id = this.fonts.length;
    this.fonts.push({
      id,
      name: font.getName(),
      bold: font.isBold(),
      italic: font.isItalic(),
      serif: font.isSerif(),
      mono: font.isMono(),
    });
    this.#fontIds.set(font.pointer, id);
    return id;
  }

  /** 직전 텍스트 래퍼를 놓는다. 래퍼를 놓으면 C 객체가 해제되어 주소가 재사용되므로 비교가 끝난 뒤에만 부른다. */
  #releasePrev(): void {
    if (this.#prev) {
      this.#prev.text.destroy();
      this.#prev = null;
    }
  }

  /** 텍스트가 아닌 콜백이 왔다: 연속 판정을 끊고 중복 후보 구간을 새로 연다. */
  #boundary(): void {
    this.#releasePrev();
    this.#windowStart = this.glyphs.length;
  }

  // --- 도형 ---------------------------------------------------------------------------

  fillPath(
    path: mupdf.Path,
    evenOdd: boolean,
    ctm: Matrix,
    cs: mupdf.ColorSpace,
    color: number[],
    alpha: number,
  ): void {
    this.#boundary();
    this.#path('fill', path, null, evenOdd, ctm, this.colors.paint(cs, color), alpha);
  }

  strokePath(
    path: mupdf.Path,
    stroke: mupdf.StrokeState,
    ctm: Matrix,
    cs: mupdf.ColorSpace,
    color: number[],
    alpha: number,
  ): void {
    this.#boundary();
    this.#path('stroke', path, stroke, false, ctm, this.colors.paint(cs, color), alpha);
  }

  clipPath(path: mupdf.Path, evenOdd: boolean, ctm: Matrix): void {
    this.#boundary();
    this.#path('clip', path, null, evenOdd, ctm, null, 1);
  }

  clipStrokePath(path: mupdf.Path, stroke: mupdf.StrokeState, ctm: Matrix): void {
    this.#boundary();
    this.#path('clip-stroke', path, stroke, false, ctm, null, 1);
  }

  #path(
    op: PathInfo['op'],
    path: mupdf.Path,
    stroke: mupdf.StrokeState | null,
    evenOdd: boolean,
    ctm: Matrix,
    color: PathInfo['color'],
    alpha: number,
  ): void {
    const paintSeq = this.paintSeq++;
    const walked = walkPath(path, ctm, this.includeSegments);
    // 선이 있으면 선 폭을 포함한 경계, 없으면 경로 점(곡선은 제어점 포함)의 경계.
    const bbox = stroke ? (path.getBounds(stroke, ctm) as Rect) : walked.bbox;
    this.paths.push({
      paintSeq,
      op,
      evenOdd,
      bbox,
      ctm,
      color,
      alpha,
      lineWidth: stroke ? stroke.getLineWidth() : null,
      segments: walked.segments,
    });
    if (op === 'clip' || op === 'clip-stroke') this.pushClip(intersectRect(bbox, this.top()));
  }

  // --- 이미지·셰이드 -------------------------------------------------------------------

  fillImage(image: mupdf.Image, ctm: Matrix, alpha: number): void {
    this.#boundary();
    this.#image('image', image, ctm, alpha);
  }

  fillImageMask(image: mupdf.Image, ctm: Matrix, alpha: number): void {
    this.#boundary();
    this.#image('image-mask', image, ctm, alpha);
  }

  clipImageMask(image: mupdf.Image, ctm: Matrix): void {
    this.#boundary();
    const bbox = this.#image('clip-image-mask', image, ctm, 1);
    this.pushClip(intersectRect(bbox, this.top()));
  }

  #image(op: ImageInfo['op'], image: mupdf.Image, ctm: Matrix, alpha: number): Rect {
    const bbox = transformRect(unitRect, ctm);
    this.images.push({
      paintSeq: this.paintSeq++,
      op,
      bbox,
      ctm,
      width: image.getWidth(),
      height: image.getHeight(),
      alpha,
    });
    return bbox;
  }

  fillShade(shade: mupdf.Shade, ctm: Matrix, alpha: number): void {
    this.#boundary();
    const bounds = shade.getBounds() as Rect;
    // `sh` 의 셰이드는 경계가 무한(±2^31 근처)일 수 있다. 그때는 현재 클립 경계를 쓴다.
    const unbounded = bounds.some((v) => !Number.isFinite(v) || Math.abs(v) >= 2 ** 30);
    const bbox = intersectRect(unbounded ? this.top() : transformRect(bounds, ctm), this.top());
    this.shades.push({ paintSeq: this.paintSeq++, bbox, alpha });
  }

  // --- 클립 스택 ----------------------------------------------------------------------

  /** 현재 클립 경계(페이지 공간). 셰이드 경계를 접는 데 쓴다. */
  top(): Rect {
    return this.#clipStack[this.#clipStack.length - 1]!;
  }

  pushClip(bbox: Rect): void {
    this.#clipStack.push(bbox);
  }

  popClip(): void {
    this.#boundary();
    if (this.#clipStack.length > 1) this.#clipStack.pop();
  }

  beginMask(): void {
    this.#boundary();
    this.#maskDepth++;
  }

  /** `endMask` 는 마스크를 클립으로 올린다(이후 popClip 으로 내려간다). */
  endMask(): void {
    this.#boundary();
    if (this.#maskDepth > 0) this.#maskDepth--;
    if (this.#maskDepth === 0) this.pushClip(this.top());
  }
}

interface WalkedPath {
  bbox: Rect;
  segments: PathSegment[] | null;
}

/** 경로를 한 번 돌며 페이지 공간 경계(제어점 포함)와, 요청 시 경로 공간 세그먼트를 모은다. */
function walkPath(path: mupdf.Path, ctm: Matrix, wantSegments: boolean): WalkedPath {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const segments: PathSegment[] | null = wantSegments ? [] : null;
  const include = (x: number, y: number): void => {
    const p = transformPoint(ctm, x, y);
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  };
  path.walk({
    moveTo(x, y) {
      include(x, y);
      segments?.push({ type: 'M', p: [x, y] satisfies Point });
    },
    lineTo(x, y) {
      include(x, y);
      segments?.push({ type: 'L', p: [x, y] });
    },
    curveTo(ax, ay, bx, by, cx, cy) {
      include(ax, ay);
      include(bx, by);
      include(cx, cy);
      segments?.push({ type: 'C', p1: [ax, ay], p2: [bx, by], p3: [cx, cy] });
    },
    closePath() {
      segments?.push({ type: 'Z' });
    },
  });
  const empty = x0 === Infinity;
  return { bbox: empty ? [0, 0, 0, 0] : [x0, y0, x1, y1], segments };
}
